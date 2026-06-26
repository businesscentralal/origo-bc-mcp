/**
 * Dashboard Setup UI — manage BC connections from the browser.
 *
 * Routes:
 *   GET  /setup            — HTML page
 *   GET  /api/connections  — list all connections
 *   POST /api/connections  — add or update a connection
 *   POST /api/connections/validate — validate a connection without saving
 *   DELETE /api/connections/:name  — remove a connection
 */
import { Router } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { validateConnection } from "../cli/validate.js";
import { encryptSecret, canEncryptSecrets } from "../config/resolveSecret.js";
const TOKEN_HOST = "login.microsoftonline.com";
const BC_SCOPE = "https://api.businesscentral.dynamics.com/.default";
const router = Router();
// ── Config file path resolution ──────────────────────────────────────────────
function getConfigPath() {
    if (process.env.MCP_LOCAL_SETTINGS_PATH) {
        return resolve(process.env.MCP_LOCAL_SETTINGS_PATH);
    }
    if (process.env.MCP_DATA_DIR) {
        return resolve(process.env.MCP_DATA_DIR, "local.settings.json");
    }
    return resolve(process.cwd(), "config", "local.settings.json");
}
function readConfig() {
    const path = getConfigPath();
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
function writeConfig(config) {
    const path = getConfigPath();
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}
/**
 * Encrypts secret fields in a connection object before writing to disk.
 * Uses AES-256-GCM via MCP_ENCRYPTION_KEY. Falls back to plain: prefix on Linux
 * when no key is set. On Windows, leaves values as-is (DPAPI used by CLI setup).
 */
function encryptConnectionSecrets(conn) {
    const secretFields = ["clientSecret", "refreshToken", "key"];
    for (const field of secretFields) {
        const value = conn[field];
        if (!value)
            continue;
        // Don't re-encrypt already-prefixed values
        if (value.startsWith("aes:") || value.startsWith("dpapi:") || value.startsWith("env:") || value.startsWith("keychain:") || value.startsWith("plain:")) {
            continue;
        }
        const encrypted = encryptSecret(value);
        if (encrypted) {
            conn[field] = encrypted;
        }
        else if (process.platform !== "win32") {
            // On non-Windows without encryption key, mark as plain (explicit)
            conn[field] = `plain:${value}`;
        }
    }
}
// ── API Routes ───────────────────────────────────────────────────────────────
router.get("/api/connections", (_req, res) => {
    const config = readConfig();
    const connections = [];
    if (config.devConnection) {
        connections.push({
            name: "default",
            type: config.devConnection.onPrem ? "on-prem" : "saas",
            environment: config.devConnection.environment,
            companyId: config.devConnection.companyId,
        });
    }
    if (config.connections) {
        for (const [name, conn] of Object.entries(config.connections)) {
            connections.push({
                name,
                type: conn.onPrem ? "on-prem" : "saas",
                environment: conn.environment,
                companyId: conn.companyId,
            });
        }
    }
    res.json({
        configPath: getConfigPath(),
        configExists: existsSync(getConfigPath()),
        basicAuth: config.basicAuth ? { enabled: config.basicAuth.enabled, username: config.basicAuth.username } : null,
        setupConnection: config.setupConnection,
        connections,
        encryption: {
            available: canEncryptSecrets(),
            method: canEncryptSecrets() ? "aes-256-gcm" : (process.platform === "win32" ? "dpapi" : "none"),
        },
    });
});
router.post("/api/connections", (req, res) => {
    const { name, connection, basicAuth } = req.body;
    const config = readConfig();
    if (basicAuth) {
        config.basicAuth = basicAuth;
    }
    if (connection && name) {
        // Encrypt secret fields at rest when MCP_ENCRYPTION_KEY is available
        const connToSave = { ...connection };
        encryptConnectionSecrets(connToSave);
        if (name === "default") {
            config.devConnection = connToSave;
        }
        else {
            if (!config.connections)
                config.connections = {};
            config.connections[name] = connToSave;
        }
    }
    writeConfig(config);
    res.json({ ok: true, configPath: getConfigPath(), encrypted: canEncryptSecrets() });
});
router.post("/api/connections/validate", async (req, res) => {
    const { connection, connectionName } = req.body;
    // If connectionName is provided, read it from the config file
    let connToValidate = connection;
    if (!connToValidate && connectionName) {
        const config = readConfig();
        if (connectionName === "default") {
            connToValidate = config.devConnection;
        }
        else {
            connToValidate = config.connections?.[connectionName];
        }
    }
    if (!connToValidate) {
        res.status(400).json({ ok: false, error: "No connection provided or found" });
        return;
    }
    try {
        let result;
        if (connToValidate.onPrem) {
            result = await validateConnection({
                onPrem: true,
                baseUrl: connToValidate.baseUrl,
                onPremTenant: connToValidate.onPremTenant,
                user: connToValidate.user,
                key: connToValidate.key,
                environment: connToValidate.environment,
                companyId: connToValidate.companyId,
                companyName: connToValidate.companyName,
            });
        }
        else {
            result = await validateConnection({
                tenantId: connToValidate.tenantId,
                clientId: connToValidate.clientId,
                clientSecret: connToValidate.clientSecret,
                refreshToken: connToValidate.refreshToken,
                environment: connToValidate.environment || "production",
                companyId: connToValidate.companyId,
            });
        }
        res.json(result);
    }
    catch (err) {
        res.json({ ok: false, error: err.message });
    }
});
router.delete("/api/connections/:name", (req, res) => {
    const name = req.params.name;
    const config = readConfig();
    if (name === "default") {
        delete config.devConnection;
    }
    else if (config.connections) {
        delete config.connections[name];
        if (Object.keys(config.connections).length === 0) {
            delete config.connections;
        }
    }
    writeConfig(config);
    res.json({ ok: true });
});
// ── Device Code Flow (browser-friendly) ──────────────────────────────────────
// Active device code sessions (keyed by a random session ID)
const deviceCodeSessions = new Map();
/**
 * Step 1: Start device code flow — returns user_code + verification_uri.
 * The UI shows these to the user and starts polling step 2.
 */
router.post("/api/device-code/start", async (req, res) => {
    const { tenantId, clientId } = req.body;
    if (!tenantId || !clientId) {
        res.status(400).json({ ok: false, error: "tenantId and clientId are required" });
        return;
    }
    try {
        const dcRes = await fetch(`https://${TOKEN_HOST}/${tenantId}/oauth2/v2.0/devicecode`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, scope: `${BC_SCOPE} offline_access` }),
        });
        const dc = await dcRes.json();
        if (!dc.device_code) {
            res.json({ ok: false, error: dc.error_description || dc.error || "Device code request failed — check tenantId and clientId." });
            return;
        }
        // Store session for polling
        const sessionId = crypto.randomUUID();
        deviceCodeSessions.set(sessionId, {
            deviceCode: dc.device_code,
            clientId,
            tenantId,
            interval: Math.max(dc.interval || 5, 5),
            expiresAt: Date.now() + (dc.expires_in || 900) * 1000,
        });
        // Auto-cleanup after expiry
        setTimeout(() => deviceCodeSessions.delete(sessionId), (dc.expires_in || 900) * 1000 + 5000);
        res.json({
            ok: true,
            sessionId,
            userCode: dc.user_code,
            verificationUri: dc.verification_uri,
            message: dc.message,
            expiresIn: dc.expires_in,
            interval: Math.max(dc.interval || 5, 5),
        });
    }
    catch (err) {
        res.json({ ok: false, error: err.message });
    }
});
/**
 * Step 2: Poll for token — call this repeatedly until it returns a refresh_token or error.
 */
router.post("/api/device-code/poll", async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        res.status(400).json({ ok: false, error: "sessionId is required" });
        return;
    }
    const session = deviceCodeSessions.get(sessionId);
    if (!session) {
        res.json({ ok: false, error: "Session expired or not found. Start a new device code flow." });
        return;
    }
    if (Date.now() > session.expiresAt) {
        deviceCodeSessions.delete(sessionId);
        res.json({ ok: false, error: "Device code expired. Start a new flow." });
        return;
    }
    try {
        const tokRes = await fetch(`https://${TOKEN_HOST}/${session.tenantId}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: session.clientId,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: session.deviceCode,
            }),
        });
        const tok = await tokRes.json();
        if (tok.refresh_token) {
            deviceCodeSessions.delete(sessionId);
            res.json({ ok: true, refreshToken: tok.refresh_token });
            return;
        }
        if (tok.error === "authorization_pending") {
            res.json({ ok: false, pending: true });
            return;
        }
        if (tok.error === "slow_down") {
            res.json({ ok: false, pending: true, slowDown: true });
            return;
        }
        deviceCodeSessions.delete(sessionId);
        res.json({ ok: false, error: tok.error_description || tok.error || "Token request failed" });
    }
    catch (err) {
        res.json({ ok: false, error: err.message });
    }
});
// ── HTML page ────────────────────────────────────────────────────────────────
router.get("/", (_req, res) => {
    res.type("html").send(SETUP_HTML);
});
export { router as setupRouter };
// ── Inline HTML ──────────────────────────────────────────────────────────────
const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Origo MCP — Setup</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --green: #3fb950;
    --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h1 span { color: var(--blue); }
  .subtitle { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .nav { margin-bottom: 20px; font-size: 13px; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 16px;
  }
  .card h3 { font-size: 14px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 600; }
  .badge.saas { background: #1f3a5f; color: var(--blue); }
  .badge.on-prem { background: #2d1f00; color: var(--yellow); }
  .conn-meta { font-size: 12px; color: var(--dim); margin-bottom: 8px; }
  .conn-actions { display: flex; gap: 8px; }
  .btn {
    padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); color: var(--text); cursor: pointer; font-size: 13px;
  }
  .btn:hover { border-color: var(--blue); }
  .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .btn.primary:hover { background: #388bfd; }
  .btn.danger { color: var(--red); }
  .btn.danger:hover { border-color: var(--red); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm { padding: 4px 10px; font-size: 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--blue); cursor: pointer; }
  .btn-sm:hover { border-color: var(--blue); background: #1f6feb22; }
  .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center; }
  .modal-overlay.active { display:flex; }
  .modal { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:24px; width:100%; max-width:440px; text-align:center; }
  .modal h3 { margin-bottom:12px; font-size:16px; }
  .modal .user-code { font-family:monospace; font-size:28px; letter-spacing:4px; color:var(--blue); margin:16px 0; padding:12px; background:var(--bg); border-radius:8px; border:1px solid var(--border); user-select:all; }
  .modal .hint { color:var(--dim); font-size:13px; margin-bottom:16px; }
  .modal .status { color:var(--dim); font-size:13px; margin-top:12px; }
  .modal .status.error { color:var(--red); }
  .modal .status.success { color:var(--green); }
  .form-section { margin-top: 20px; }
  .form-section h2 { font-size: 16px; margin-bottom: 12px; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .form-group { display: flex; flex-direction: column; gap: 4px; }
  .form-group.full { grid-column: 1 / -1; }
  .form-group label { font-size: 12px; color: var(--dim); font-weight: 600; text-transform: uppercase; }
  .form-group input, .form-group select {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 8px 12px; font-size: 14px;
  }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--blue); }
  .form-group .hint { font-size: 11px; color: var(--dim); }
  .form-actions { margin-top: 16px; display: flex; gap: 8px; align-items: center; }
  .result { margin-top: 12px; padding: 10px 14px; border-radius: 6px; font-size: 13px; }
  .result.ok { background: #0d2818; border: 1px solid #196c2e; color: var(--green); }
  .result.err { background: #2d1117; border: 1px solid #6e2d2d; color: var(--red); }
  .result.info { background: #1c1d21; border: 1px solid var(--border); color: var(--dim); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--blue); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: var(--dim); font-style: italic; }
  .config-path { font-size: 12px; color: var(--dim); font-family: monospace; margin-bottom: 16px; padding: 8px 12px; background: var(--surface); border-radius: 4px; }
  .type-toggle { display: flex; gap: 0; margin-bottom: 16px; }
  .type-toggle button { padding: 8px 16px; border: 1px solid var(--border); background: var(--bg); color: var(--dim); cursor: pointer; font-size: 13px; }
  .type-toggle button:first-child { border-radius: 6px 0 0 6px; }
  .type-toggle button:last-child { border-radius: 0 6px 6px 0; }
  .type-toggle button.active { background: var(--surface); color: var(--text); border-color: var(--blue); }
  .basic-auth-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
  .basic-auth-section h3 { font-size: 14px; margin-bottom: 12px; }
  .toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .toggle-row input[type="checkbox"] { width: 16px; height: 16px; }
</style>
</head>
<body>
<h1><span>●</span> Origo MCP <span>Setup</span></h1>
<p class="subtitle">Manage Business Central connections</p>
<div class="nav"><a href="/dashboard">← Back to Dashboard</a></div>

<div class="config-path" id="config-path">Loading…</div>

<div id="connections"></div>

<div class="form-section">
  <h2>Add / Edit Connection</h2>
  <div class="form-group" style="margin-bottom:12px">
    <label>Connection Name</label>
    <input type="text" id="conn-name" placeholder="e.g. production, sandbox, default" value="default">
    <span class="hint">"default" is the primary connection used when no ?connection= param is specified</span>
  </div>

  <div class="type-toggle">
    <button id="type-saas" class="active" onclick="setType('saas')">SaaS (Entra)</button>
    <button id="type-onprem" onclick="setType('onprem')">On-Premises</button>
  </div>

  <div id="saas-fields" class="form-grid">
    <div class="form-group"><label>Tenant ID</label><input type="text" id="tenantId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>
    <div class="form-group"><label>Client ID</label><input type="text" id="clientId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>
    <div class="form-group"><label>Client Secret</label><input type="password" id="clientSecret" placeholder="Secret or env:VAR_NAME"><span class="hint">Leave blank if using refresh token</span></div>
    <div class="form-group"><label>Refresh Token</label><input type="password" id="refreshToken" placeholder="Leave blank if using client secret"><span class="hint">For delegated access (device code flow)</span><button type="button" class="btn-sm" onclick="startDeviceCode()" id="dc-btn" style="margin-top:4px">🔑 Get Refresh Token</button></div>
    <div class="form-group"><label>Environment</label><input type="text" id="saas-env" placeholder="production" value="production"></div>
    <div class="form-group"><label>Company ID</label><input type="text" id="saas-companyId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"><span class="hint">Optional — limits to one company</span></div>
  </div>

  <div id="onprem-fields" class="form-grid" style="display:none">
    <div class="form-group full"><label>Base URL</label><input type="text" id="baseUrl" placeholder="https://hostname:443/bc-instance/rest"><span class="hint">The REST base URL (without /api/…)</span></div>
    <div class="form-group"><label>Tenant</label><input type="text" id="onPremTenant" placeholder="default" value="default"></div>
    <div class="form-group"><label>Username</label><input type="text" id="opUser" placeholder="BC web service user"></div>
    <div class="form-group"><label>Web Service Key</label><input type="password" id="opKey" placeholder="Web service access key"></div>
    <div class="form-group"><label>Company ID</label><input type="text" id="op-companyId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>
    <div class="form-group"><label>Company Name</label><input type="text" id="op-companyName" placeholder="CRONUS International Ltd."></div>
    <div class="form-group"><label>Environment Label</label><input type="text" id="op-env" placeholder="onprem" value="onprem"><span class="hint">Display name for this environment</span></div>
  </div>

  <div class="form-actions">
    <button class="btn primary" onclick="saveConn()">Save Connection</button>
    <button class="btn" onclick="validateConn()">Validate</button>
    <span id="form-spinner" style="display:none"><span class="spinner"></span></span>
  </div>
  <div id="form-result"></div>
</div>

<div class="basic-auth-section">
  <h3>Basic Auth</h3>
  <p style="font-size:12px;color:var(--dim);margin-bottom:12px">Secures MCP endpoints and the dashboard. Same credentials used for MCP client access.</p>
  <div class="toggle-row">
    <input type="checkbox" id="ba-enabled">
    <label for="ba-enabled" style="font-size:13px">Enable Basic Auth</label>
  </div>
  <div class="form-grid" style="max-width:500px">
    <div class="form-group"><label>Username</label><input type="text" id="ba-user" placeholder="dev"></div>
    <div class="form-group"><label>Password</label><input type="password" id="ba-pass" placeholder="your-password"></div>
  </div>
  <div style="margin-top:12px"><button class="btn" onclick="saveBasicAuth()">Save Basic Auth</button></div>
  <div id="ba-result"></div>
</div>

<script>
let connType = 'saas';

function setType(t) {
  connType = t;
  document.getElementById('type-saas').className = t === 'saas' ? 'active' : '';
  document.getElementById('type-onprem').className = t === 'onprem' ? 'active' : '';
  document.getElementById('saas-fields').style.display = t === 'saas' ? '' : 'none';
  document.getElementById('onprem-fields').style.display = t === 'onprem' ? '' : 'none';
}

async function loadConnections() {
  const r = await fetch('/dashboard/setup/api/connections');
  const d = await r.json();
  document.getElementById('config-path').textContent = (d.configExists ? '✓ ' : '⚠ No config — ') + d.configPath;

  if (d.basicAuth) {
    document.getElementById('ba-enabled').checked = d.basicAuth.enabled;
    document.getElementById('ba-user').value = d.basicAuth.username || '';
  }

  const el = document.getElementById('connections');
  if (d.connections.length === 0) {
    el.innerHTML = '<div class="card"><p class="empty">No connections configured. Add one below.</p></div>';
    return;
  }

  el.innerHTML = d.connections.map(c => \`
    <div class="card">
      <h3>\${c.name} <span class="badge \${c.type}">\${c.type}</span></h3>
      <div class="conn-meta">Environment: \${c.environment || '—'} &nbsp;|&nbsp; Company: \${c.companyId ? c.companyId.slice(0,8)+'…' : 'all'}</div>
      <div class="conn-actions">
        <button class="btn" onclick="editConn('\${c.name}')">Edit</button>
        <button class="btn" onclick="testConn('\${c.name}')">Test</button>
        <button class="btn danger" onclick="deleteConn('\${c.name}')">Remove</button>
      </div>
      <div id="conn-result-\${c.name}"></div>
    </div>
  \`).join('');
}

function buildConnection() {
  if (connType === 'onprem') {
    return {
      onPrem: true,
      baseUrl: document.getElementById('baseUrl').value.trim(),
      onPremTenant: document.getElementById('onPremTenant').value.trim() || 'default',
      user: document.getElementById('opUser').value.trim(),
      key: document.getElementById('opKey').value.trim(),
      companyId: document.getElementById('op-companyId').value.trim() || undefined,
      companyName: document.getElementById('op-companyName').value.trim() || undefined,
      environment: document.getElementById('op-env').value.trim() || 'onprem',
    };
  }
  return {
    tenantId: document.getElementById('tenantId').value.trim(),
    clientId: document.getElementById('clientId').value.trim(),
    clientSecret: document.getElementById('clientSecret').value.trim() || undefined,
    refreshToken: document.getElementById('refreshToken').value.trim() || undefined,
    environment: document.getElementById('saas-env').value.trim() || 'production',
    companyId: document.getElementById('saas-companyId').value.trim() || undefined,
  };
}

async function validateConn() {
  const conn = buildConnection();
  const el = document.getElementById('form-result');
  document.getElementById('form-spinner').style.display = '';
  el.innerHTML = '';
  try {
    const r = await fetch('/dashboard/setup/api/connections/validate', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ connection: conn })
    });
    const d = await r.json();
    if (d.ok) {
      const companies = d.companies ? d.companies.map(c => c.name).join(', ') : '';
      el.innerHTML = '<div class="result ok">✓ Connection successful' + (companies ? '. Companies: ' + companies : '') + '</div>';
    } else {
      el.innerHTML = '<div class="result err">✗ ' + (d.error || 'Validation failed') + '</div>';
    }
  } catch(e) {
    el.innerHTML = '<div class="result err">✗ Request failed: ' + e.message + '</div>';
  }
  document.getElementById('form-spinner').style.display = 'none';
}

async function saveConn() {
  const name = document.getElementById('conn-name').value.trim();
  if (!name) { alert('Enter a connection name'); return; }
  const conn = buildConnection();
  const r = await fetch('/dashboard/setup/api/connections', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, connection: conn })
  });
  const d = await r.json();
  if (d.ok) {
    document.getElementById('form-result').innerHTML = '<div class="result ok">✓ Saved to ' + d.configPath + '</div>';
    loadConnections();
  }
}

async function deleteConn(name) {
  if (!confirm('Remove connection "' + name + '"?')) return;
  await fetch('/dashboard/setup/api/connections/' + encodeURIComponent(name), { method: 'DELETE' });
  loadConnections();
}

async function testConn(name) {
  const el = document.getElementById('conn-result-' + name);
  el.innerHTML = '<div class="result info"><span class="spinner"></span> Validating…</div>';
  const r = await fetch('/dashboard/setup/api/connections');
  const d = await r.json();
  // Read the full connection from the config to validate it
  const connR = await fetch('/dashboard/setup/api/connections/validate', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ connectionName: name })
  });
  const result = await connR.json();
  if (result.ok) {
    el.innerHTML = '<div class="result ok">✓ Connected' + (result.companies ? ' — ' + result.companies.length + ' companies' : '') + '</div>';
  } else {
    el.innerHTML = '<div class="result err">✗ ' + (result.error || 'Failed') + '</div>';
  }
}

async function editConn(name) {
  // For now, just set the name field — user can re-fill and save to overwrite
  document.getElementById('conn-name').value = name;
  document.getElementById('conn-name').focus();
  document.getElementById('form-result').innerHTML = '<div class="result info">Fill in the fields and click Save to update "' + name + '"</div>';
}

async function saveBasicAuth() {
  const ba = {
    enabled: document.getElementById('ba-enabled').checked,
    username: document.getElementById('ba-user').value.trim(),
    password: document.getElementById('ba-pass').value.trim(),
  };
  const r = await fetch('/dashboard/setup/api/connections', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ basicAuth: ba })
  });
  const d = await r.json();
  const el = document.getElementById('ba-result');
  if (d.ok) el.innerHTML = '<div class="result ok" style="margin-top:8px">✓ Saved</div>';
}

// ── Device Code Flow ──────────────────────────────────────────────────────────
let dcPollTimer = null;

async function startDeviceCode() {
  const tenantId = document.getElementById('tenantId').value.trim();
  const clientId = document.getElementById('clientId').value.trim();
  if (!tenantId || !clientId) {
    alert('Fill in Tenant ID and Client ID first.');
    return;
  }

  const modal = document.getElementById('dc-modal');
  const statusEl = document.getElementById('dc-status');
  const codeEl = document.getElementById('dc-code');
  const linkEl = document.getElementById('dc-link');
  statusEl.className = 'status';
  statusEl.textContent = 'Starting…';
  codeEl.textContent = '…';
  modal.classList.add('active');

  try {
    const r = await fetch('/dashboard/setup/api/device-code/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tenantId, clientId })
    });
    const d = await r.json();
    if (!d.ok) { statusEl.textContent = d.error; statusEl.className = 'status error'; return; }

    codeEl.textContent = d.userCode;
    linkEl.href = d.verificationUri;
    linkEl.textContent = d.verificationUri;
    statusEl.textContent = 'Waiting for you to sign in…';

    // Open verification URL in new tab
    window.open(d.verificationUri, '_blank');

    // Start polling
    const interval = (d.interval || 5) * 1000;
    dcPollTimer = setInterval(() => pollDeviceCode(d.sessionId, statusEl, modal), interval);
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.className = 'status error';
  }
}

async function pollDeviceCode(sessionId, statusEl, modal) {
  try {
    const r = await fetch('/dashboard/setup/api/device-code/poll', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId })
    });
    const d = await r.json();

    if (d.ok && d.refreshToken) {
      clearInterval(dcPollTimer);
      document.getElementById('refreshToken').value = d.refreshToken;
      statusEl.textContent = '✓ Got refresh token!';
      statusEl.className = 'status success';
      setTimeout(() => modal.classList.remove('active'), 1500);
      return;
    }
    if (d.pending) {
      statusEl.textContent = 'Waiting for you to sign in…';
      return;
    }
    // Error
    clearInterval(dcPollTimer);
    statusEl.textContent = d.error || 'Failed';
    statusEl.className = 'status error';
  } catch (e) {
    clearInterval(dcPollTimer);
    statusEl.textContent = e.message;
    statusEl.className = 'status error';
  }
}

function closeDcModal() {
  clearInterval(dcPollTimer);
  document.getElementById('dc-modal').classList.remove('active');
}

loadConnections();
</script>

<!-- Device Code Modal -->
<div class="modal-overlay" id="dc-modal">
  <div class="modal">
    <h3>🔑 Device Code Sign-In</h3>
    <p class="hint">Enter this code at the Microsoft sign-in page:</p>
    <div class="user-code" id="dc-code">…</div>
    <p class="hint"><a id="dc-link" href="#" target="_blank" style="color:var(--blue)">https://microsoft.com/devicelogin</a></p>
    <p class="status" id="dc-status">Starting…</p>
    <button class="btn" onclick="closeDcModal()" style="margin-top:16px">Cancel</button>
  </div>
</div>
</body>
</html>`;
//# sourceMappingURL=setup.js.map