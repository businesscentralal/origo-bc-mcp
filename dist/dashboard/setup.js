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
import { randomBytes, createHash } from "node:crypto";
import { validateConnection } from "../cli/validate.js";
import { encryptSecret, canEncryptSecrets, wrapDpapi, writeKeychain, resolveSecret } from "../config/resolveSecret.js";
import { invalidateSettingsCache } from "../config/localSettings.js";
import { config } from "../config.js";
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
    invalidateSettingsCache();
}
/**
 * Encrypts secret fields in a connection object before writing to disk.
 * Prefers AES-256-GCM (MCP_ENCRYPTION_KEY); falls back to Windows DPAPI or
 * macOS Keychain so secrets are never left as bare, unmarked plaintext.
 */
function encryptConnectionSecrets(conn, connName) {
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
        else if (process.platform === "win32") {
            conn[field] = wrapDpapi(value);
        }
        else if (process.platform === "darwin") {
            conn[field] = writeKeychain(`origo-bc-mcp-${connName}-${field}`, value);
        }
        else {
            // No OS-level secret store available — mark explicitly rather than leaving bare plaintext.
            conn[field] = `plain:${value}`;
        }
    }
}
function secretStorageMethod() {
    if (canEncryptSecrets())
        return "aes-256-gcm";
    if (process.platform === "win32")
        return "dpapi";
    if (process.platform === "darwin")
        return "keychain";
    return "plaintext";
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
    const envControlled = Boolean(process.env.MCP_ADMIN_USER && process.env.MCP_ADMIN_PASSWORD);
    res.json({
        configPath: getConfigPath(),
        configExists: existsSync(getConfigPath()),
        basicAuth: config.basicAuth ? { enabled: config.basicAuth.enabled, username: config.basicAuth.username } : null,
        basicAuthEnvControlled: envControlled,
        connections,
        encryption: {
            available: canEncryptSecrets(),
            method: secretStorageMethod(),
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
        // Encrypt secret fields at rest (AES-256-GCM, or DPAPI/Keychain fallback)
        const connToSave = { ...connection };
        encryptConnectionSecrets(connToSave, name);
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
    res.json({ ok: true, configPath: getConfigPath(), encrypted: canEncryptSecrets(), secretStorageMethod: secretStorageMethod() });
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
                key: resolveSecret(connToValidate.key),
                environment: connToValidate.environment,
                companyId: connToValidate.companyId,
                companyName: connToValidate.companyName,
            });
        }
        else {
            result = await validateConnection({
                tenantId: connToValidate.tenantId,
                clientId: connToValidate.clientId,
                clientSecret: resolveSecret(connToValidate.clientSecret),
                refreshToken: resolveSecret(connToValidate.refreshToken),
                environment: connToValidate.environment || "production",
                companyId: connToValidate.companyId,
            }, { allowInteractive: false });
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
// ── Authorization Code + PKCE flow (browser popup) ────────────────────────────
//
// Replaces the legacy device-code flow. Device code is phishable (an attacker
// can relay the code to a victim and have them approve the attacker's own
// session). Authorization Code + PKCE, bound to this dashboard's own TLS
// origin and validated via `state`, is the Microsoft-recommended flow for
// apps that can redirect a browser back to themselves.
//
// Prerequisite: the app registration needs a "Mobile and desktop applications"
// platform redirect URI matching exactly
// `${MCP_PUBLIC_URL}/dashboard/setup/api/auth-code/callback`. NOT "Web" (forces
// a client secret) and NOT "SPA" (its tokens can only ever be redeemed via
// browser CORS, which breaks our server's later refresh_token redemption).
function base64url(input) {
    return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Active auth-code sessions, keyed by the PKCE `state` value.
const authCodeSessions = new Map();
function callbackRedirectUri() {
    return `${config.publicUrl}/dashboard/setup/api/auth-code/callback`;
}
/**
 * Step 1: Start the auth-code flow — returns the authorize URL for the
 * frontend to open in a popup window.
 */
router.post("/api/auth-code/start", (req, res) => {
    const { tenantId, clientId } = req.body;
    if (!tenantId || !clientId) {
        res.status(400).json({ ok: false, error: "tenantId and clientId are required" });
        return;
    }
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
    const state = base64url(randomBytes(16));
    authCodeSessions.set(state, {
        codeVerifier,
        clientId,
        tenantId,
        expiresAt: Date.now() + 10 * 60 * 1000,
    });
    setTimeout(() => authCodeSessions.delete(state), 10 * 60 * 1000 + 5000);
    const authUrl = new URL(`https://${TOKEN_HOST}/${tenantId}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", callbackRedirectUri());
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("scope", `${BC_SCOPE} offline_access`);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    res.json({ ok: true, authUrl: authUrl.toString() });
});
/**
 * Step 2: Entra redirects the popup here with `code` + `state`. Exchanges the
 * code for tokens server-side (this redirect URI is registered under the
 * "Mobile and desktop applications" platform, a public client type that
 * supports server-side redemption with no secret and no CORS restriction —
 * unlike SPA-type redirects, whose tokens are permanently browser-only), then
 * posts the result back to the opener via `postMessage` and closes itself.
 */
router.get("/api/auth-code/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;
    const respondHtml = (payload) => {
        res.type("html").send(`<!DOCTYPE html><html><body>
<script>
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify({ type: "auth-code-callback", ...payload })}, window.location.origin);
  }
  window.close();
</script>
<p>You can close this window.</p>
</body></html>`);
    };
    if (error || !code || !state) {
        respondHtml({ ok: false, error: error_description || error || "Missing authorization code" });
        return;
    }
    const session = authCodeSessions.get(state);
    authCodeSessions.delete(state);
    if (!session || Date.now() > session.expiresAt) {
        respondHtml({ ok: false, error: "Sign-in session expired or not found. Please try again." });
        return;
    }
    try {
        const tokRes = await fetch(`https://${TOKEN_HOST}/${session.tenantId}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: session.clientId,
                grant_type: "authorization_code",
                code,
                redirect_uri: callbackRedirectUri(),
                code_verifier: session.codeVerifier,
                scope: `${BC_SCOPE} offline_access`,
            }),
        });
        const tok = await tokRes.json();
        if (!tok.refresh_token) {
            respondHtml({ ok: false, error: tok.error_description || tok.error || "Token exchange failed" });
            return;
        }
        respondHtml({ ok: true, refreshToken: tok.refresh_token });
    }
    catch (err) {
        respondHtml({ ok: false, error: err.message });
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
<div class="config-path" id="secret-storage">Loading…</div>

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
    <div class="form-group"><label>Refresh Token</label><input type="password" id="refreshToken" placeholder="Leave blank if using client secret"><span class="hint">For delegated access (browser sign-in)</span><button type="button" class="btn-sm" onclick="startAuthCode()" id="dc-btn" style="margin-top:4px">🔑 Get Refresh Token</button></div>
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

<div class="basic-auth-section" id="ba-section">
  <h3>Basic Auth</h3>
  <p style="font-size:12px;color:var(--dim);margin-bottom:12px" id="ba-desc">Secures MCP endpoints and the dashboard. Same credentials used for MCP client access.</p>
  <div id="ba-env-notice" style="display:none;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:12px">
    <span style="color:var(--green)">✓</span> <strong>Controlled by environment variables</strong> <span style="color:var(--dim)">(MCP_ADMIN_USER / MCP_ADMIN_PASSWORD)</span>
    <div style="margin-top:6px;font-size:12px;color:var(--dim)">Username: <strong id="ba-env-user"></strong> — change via <code>docker run -e</code> flags.</div>
  </div>
  <div id="ba-form">
    <div class="toggle-row">
      <input type="checkbox" id="ba-enabled">
      <label for="ba-enabled" style="font-size:13px">Enable Basic Auth</label>
    </div>
    <div class="form-grid" style="max-width:500px">
      <div class="form-group"><label>Username</label><input type="text" id="ba-user" placeholder="admin"></div>
      <div class="form-group"><label>Password</label><input type="password" id="ba-pass" placeholder="your-password"></div>
    </div>
    <div style="margin-top:12px"><button class="btn" onclick="saveBasicAuth()">Save Basic Auth</button></div>
  </div>
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

  const storageLabels = {
    'aes-256-gcm': '✓ Secrets encrypted with AES-256-GCM (MCP_ENCRYPTION_KEY)',
    'dpapi': '✓ Secrets encrypted with Windows DPAPI (this user account only)',
    'keychain': '✓ Secrets stored in macOS Keychain',
    'plaintext': '⚠ No OS secret store available — secrets stored as plain text',
  };
  const storageEl = document.getElementById('secret-storage');
  storageEl.textContent = storageLabels[d.encryption?.method] || '';
  storageEl.style.color = d.encryption?.method === 'plaintext' ? 'var(--yellow)' : 'var(--dim)';

  if (d.basicAuth) {
    document.getElementById('ba-enabled').checked = d.basicAuth.enabled;
    document.getElementById('ba-user').value = d.basicAuth.username || '';
  }

  // If env-controlled, show notice and hide edit form
  if (d.basicAuthEnvControlled) {
    document.getElementById('ba-env-notice').style.display = '';
    document.getElementById('ba-env-user').textContent = d.basicAuth?.username || '';
    document.getElementById('ba-form').style.display = 'none';
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
    document.getElementById('form-result').innerHTML = '<div class="result ok">✓ Saved to ' + d.configPath + ' (secrets: ' + d.secretStorageMethod + ')</div>';
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

// ── Auth Code + PKCE Flow (popup window) ──────────────────────────────────────
let authCodePopup = null;

function onAuthCodeMessage(event) {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.type !== 'auth-code-callback') return;

  window.removeEventListener('message', onAuthCodeMessage);
  const statusEl = document.getElementById('dc-status');
  const modal = document.getElementById('dc-modal');

  if (data.ok && data.refreshToken) {
    document.getElementById('refreshToken').value = data.refreshToken;
    statusEl.textContent = '✓ Got refresh token!';
    statusEl.className = 'status success';
    setTimeout(() => modal.classList.remove('active'), 1200);
  } else {
    statusEl.textContent = data.error || 'Sign-in failed';
    statusEl.className = 'status error';
  }
}

async function startAuthCode() {
  const tenantId = document.getElementById('tenantId').value.trim();
  const clientId = document.getElementById('clientId').value.trim();
  if (!tenantId || !clientId) {
    alert('Fill in Tenant ID and Client ID first.');
    return;
  }

  const modal = document.getElementById('dc-modal');
  const statusEl = document.getElementById('dc-status');
  statusEl.className = 'status';
  statusEl.textContent = 'Opening sign-in window…';
  modal.classList.add('active');

  try {
    const r = await fetch('/dashboard/setup/api/auth-code/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tenantId, clientId })
    });
    const d = await r.json();
    if (!d.ok) { statusEl.textContent = d.error; statusEl.className = 'status error'; return; }

    window.addEventListener('message', onAuthCodeMessage);
    authCodePopup = window.open(d.authUrl, 'origo-bc-signin', 'width=500,height=650');
    statusEl.textContent = 'Waiting for you to sign in…';
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.className = 'status error';
  }
}

function closeDcModal() {
  window.removeEventListener('message', onAuthCodeMessage);
  if (authCodePopup && !authCodePopup.closed) authCodePopup.close();
  document.getElementById('dc-modal').classList.remove('active');
}

loadConnections();
</script>

<!-- Auth Code Sign-In Modal -->
<div class="modal-overlay" id="dc-modal">
  <div class="modal">
    <h3>🔑 Browser Sign-In</h3>
    <p class="hint">Complete sign-in in the popup window.</p>
    <p class="status" id="dc-status">Starting…</p>
    <button class="btn" onclick="closeDcModal()" style="margin-top:16px">Cancel</button>
  </div>
</div>
</body>
</html>`;
//# sourceMappingURL=setup.js.map