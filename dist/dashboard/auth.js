import { getLocalSettings } from "../config/localSettings.js";
const COOKIE_NAME = "mcp_dash_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Simple in-memory session tokens
const sessions = new Map(); // token → expiry timestamp
function generateToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function cleanExpired() {
    const now = Date.now();
    for (const [token, expiry] of sessions) {
        if (expiry < now)
            sessions.delete(token);
    }
}
/** Check if dashboard auth is required (basic auth configured). */
export function isDashboardAuthRequired() {
    const ls = getLocalSettings();
    return Boolean(ls.basicAuth?.enabled && ls.basicAuth.username && ls.basicAuth.password);
}
/** Validate credentials against local settings. */
export function validateCredentials(username, password) {
    const ls = getLocalSettings();
    if (!ls.basicAuth?.enabled)
        return false;
    return username === ls.basicAuth.username && password === ls.basicAuth.password;
}
/** Express middleware — protects dashboard routes. */
export function dashboardAuth(req, res, next) {
    // If no auth is configured, allow access (first-time setup)
    if (!isDashboardAuthRequired()) {
        next();
        return;
    }
    // Check session cookie
    const cookieHeader = req.headers.cookie || "";
    const cookies = Object.fromEntries(cookieHeader.split(";").map((c) => {
        const [k, ...v] = c.trim().split("=");
        return [k, v.join("=")];
    }));
    const sessionToken = cookies[COOKIE_NAME];
    if (sessionToken && sessions.has(sessionToken)) {
        const expiry = sessions.get(sessionToken);
        if (expiry > Date.now()) {
            next();
            return;
        }
        sessions.delete(sessionToken);
    }
    // Check Basic auth header (for API calls or programmatic access)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Basic ")) {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
        const [user, pass] = decoded.split(":");
        if (user && pass && validateCredentials(user, pass)) {
            next();
            return;
        }
    }
    // Not authenticated — serve login page for HTML requests, 401 for API
    if (req.path.startsWith("/api/") || req.path === "/logs") {
        res.status(401).json({ error: "Authentication required" });
        return;
    }
    // Serve login page
    res.type("html").send(LOGIN_HTML);
}
/** Login endpoint — returns session cookie. */
export function handleLogin(req, res) {
    const { username, password } = req.body;
    if (!username || !password || !validateCredentials(username, password)) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
    }
    cleanExpired();
    const token = generateToken();
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: SESSION_TTL_MS,
        secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    });
    res.json({ ok: true });
}
/** Logout endpoint — clears session. */
export function handleLogout(req, res) {
    const cookieHeader = req.headers.cookie || "";
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (match?.[1])
        sessions.delete(match[1]);
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
}
// ── Login page HTML ──────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Origo MCP — Login</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --blue: #58a6ff; --red: #f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 32px; width: 100%; max-width: 360px;
  }
  h1 { font-size: 18px; text-align: center; margin-bottom: 4px; }
  h1 span { color: var(--blue); }
  .subtitle { text-align: center; color: var(--dim); font-size: 13px; margin-bottom: 24px; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 12px; color: var(--dim); font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
  .form-group input {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 10px 12px; font-size: 14px;
  }
  .form-group input:focus { outline: none; border-color: var(--blue); }
  .btn {
    width: 100%; padding: 10px; border: none; border-radius: 6px;
    background: #1f6feb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .btn:hover { background: #388bfd; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { color: var(--red); font-size: 13px; text-align: center; margin-top: 12px; display: none; }
</style>
</head>
<body>
<div class="login-card">
  <h1><span>●</span> Origo MCP</h1>
  <p class="subtitle">Sign in to dashboard</p>
  <form id="login-form" onsubmit="return doLogin(event)">
    <div class="form-group">
      <label>Username</label>
      <input type="text" id="username" autocomplete="username" autofocus required>
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="password" autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn" id="submit-btn">Sign In</button>
  </form>
  <p class="error" id="error-msg">Invalid username or password</p>
</div>
<script>
async function doLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('submit-btn');
  const err = document.getElementById('error-msg');
  btn.disabled = true;
  err.style.display = 'none';
  try {
    const r = await fetch('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    if (r.ok) {
      window.location.reload();
    } else {
      err.style.display = '';
    }
  } catch { err.style.display = ''; }
  btn.disabled = false;
  return false;
}
</script>
</body>
</html>`;
//# sourceMappingURL=auth.js.map