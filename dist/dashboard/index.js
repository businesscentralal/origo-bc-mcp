/**
 * Dashboard — lightweight admin UI served at /dashboard.
 *
 * Features:
 *   • Real-time console log (SSE stream)
 *   • Active session list
 *   • Server stats (uptime, memory, version)
 *   • Restart / stop via PM2 programmatic API (when available)
 */
import { Router } from "express";
import { subscribe, getBuffer, subscriberCount } from "./logBuffer.js";
// Session tracking — populated by index.ts via setSessionTracker
let sessionTracker;
export function setSessionTracker(fn) {
    sessionTracker = fn;
}
const router = Router();
// ---- HTML page ----------------------------------------------------------
router.get("/", (_req, res) => {
    res.type("html").send(PAGE_HTML);
});
// ---- SSE log stream -----------------------------------------------------
router.get("/logs", (_req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    // Send buffered history
    for (const entry of getBuffer()) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    const unsub = subscribe((entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });
    _req.on("close", unsub);
});
// ---- JSON API -----------------------------------------------------------
router.get("/api/status", (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
        uptime: process.uptime(),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        sessions: sessionTracker ? sessionTracker() : [],
        subscribers: subscriberCount(),
        nodeVersion: process.version,
        pid: process.pid,
    });
});
router.post("/api/restart", async (_req, res) => {
    try {
        // pm2 is only available in the container — dynamic require with type suppression
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pm2 = await Function('return import("pm2")')();
        pm2.default.restart("mcp-server", (err) => {
            if (err)
                return res.status(500).json({ error: err.message });
            res.json({ ok: true, action: "restart" });
        });
    }
    catch {
        // No PM2 — try graceful exit (Docker/systemd will restart)
        res.json({ ok: true, action: "exit", note: "Process exiting — container will restart" });
        setTimeout(() => process.exit(0), 500);
    }
});
router.post("/api/stop", async (_req, res) => {
    try {
        const pm2 = await Function('return import("pm2")')();
        pm2.default.stop("mcp-server", (err) => {
            if (err)
                return res.status(500).json({ error: err.message });
            res.json({ ok: true, action: "stop" });
        });
    }
    catch {
        res.json({ ok: true, action: "exit", note: "Process exiting" });
        setTimeout(() => process.exit(0), 500);
    }
});
export { router as dashboardRouter };
// ---- Inline HTML --------------------------------------------------------
const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Origo MCP Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --green: #3fb950;
    --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, monospace; background: var(--bg); color: var(--text); }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 16px; font-weight: 600; }
  header h1 span { color: var(--blue); }
  .actions { display: flex; gap: 8px; }
  .actions button {
    padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); color: var(--text); cursor: pointer; font-size: 13px;
  }
  .actions button:hover { border-color: var(--blue); }
  .actions .restart { color: var(--yellow); }
  .actions .stop { color: var(--red); }
  .stats {
    display: flex; gap: 20px; padding: 10px 20px;
    background: var(--surface); border-bottom: 1px solid var(--border); font-size: 13px; color: var(--dim);
  }
  .stats .val { color: var(--text); font-weight: 600; }
  .panels { display: flex; height: calc(100vh - 90px); }
  .log-panel { flex: 1; display: flex; flex-direction: column; }
  .side-panel {
    width: 280px; border-left: 1px solid var(--border); background: var(--surface);
    overflow-y: auto; padding: 12px; font-size: 13px;
  }
  .side-panel h3 { font-size: 12px; text-transform: uppercase; color: var(--dim); margin-bottom: 8px; }
  .session-item {
    padding: 6px 8px; margin-bottom: 4px; border-radius: 4px;
    background: var(--bg); border: 1px solid var(--border); font-family: monospace; font-size: 12px;
  }
  .session-item .sid { color: var(--blue); }
  .session-item .age { color: var(--dim); font-size: 11px; }
  #log {
    flex: 1; overflow-y: auto; padding: 8px 12px;
    font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
  }
  .log-line { padding: 1px 0; }
  .log-line .ts { color: var(--dim); margin-right: 8px; }
  .log-line.error { color: var(--red); }
  .log-line.warn { color: var(--yellow); }
  .log-toolbar {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 12px; background: var(--surface); border-bottom: 1px solid var(--border);
    border-top: 1px solid var(--border); font-size: 12px; color: var(--dim);
  }
  .log-toolbar label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .log-toolbar input[type="text"] {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    padding: 3px 8px; border-radius: 4px; font-size: 12px; width: 200px;
  }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.on { background: var(--green); }
  .dot.off { background: var(--red); }
  .empty { color: var(--dim); font-style: italic; padding: 20px 0; text-align: center; }
</style>
</head>
<body>
<header>
  <h1><span>●</span> Origo MCP <span>Dashboard</span></h1>
  <div class="actions">
    <button class="restart" onclick="api('restart')">⟳ Restart</button>
    <button class="stop" onclick="api('stop')">■ Stop</button>
  </div>
</header>
<div class="stats" id="stats">
  <span>Uptime: <span class="val" id="s-uptime">—</span></span>
  <span>Memory: <span class="val" id="s-mem">—</span></span>
  <span>Sessions: <span class="val" id="s-sessions">—</span></span>
  <span>PID: <span class="val" id="s-pid">—</span></span>
  <span>Node: <span class="val" id="s-node">—</span></span>
  <span><span class="dot on" id="s-dot"></span><span id="s-status">Connected</span></span>
</div>
<div class="panels">
  <div class="log-panel">
    <div class="log-toolbar">
      <label><input type="checkbox" id="autoscroll" checked> Auto-scroll</label>
      <input type="text" id="filter" placeholder="Filter logs…">
      <button onclick="clearLog()" style="background:var(--bg);border:1px solid var(--border);color:var(--dim);padding:2px 8px;border-radius:4px;cursor:pointer">Clear</button>
      <span id="line-count" style="margin-left:auto">0 lines</span>
    </div>
    <div id="log"></div>
  </div>
  <div class="side-panel">
    <h3>Active Sessions</h3>
    <div id="sessions"><div class="empty">No active sessions</div></div>
  </div>
</div>
<script>
const logEl = document.getElementById('log');
const filterEl = document.getElementById('filter');
const autoscrollEl = document.getElementById('autoscroll');
const lineCountEl = document.getElementById('line-count');
let lineCount = 0;
let allLines = [];

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function formatUptime(s) {
  const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60);
  return h > 0 ? h+'h '+m+'m' : m+'m '+Math.floor(s%60)+'s';
}
function formatMB(b) { return (b/1048576).toFixed(1)+' MB'; }

function addLine(entry) {
  const div = document.createElement('div');
  div.className = 'log-line ' + entry.level;
  div.innerHTML = '<span class="ts">' + formatTime(entry.ts) + '</span>' + escapeHtml(entry.text);
  div.dataset.text = entry.text.toLowerCase();
  allLines.push(div);

  const f = filterEl.value.toLowerCase();
  if (f && !div.dataset.text.includes(f)) div.style.display = 'none';

  logEl.appendChild(div);
  lineCount++;
  lineCountEl.textContent = lineCount + ' lines';
  if (autoscrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function clearLog() {
  logEl.innerHTML = ''; lineCount = 0; allLines = [];
  lineCountEl.textContent = '0 lines';
}

filterEl.addEventListener('input', () => {
  const f = filterEl.value.toLowerCase();
  for (const div of allLines) {
    div.style.display = (!f || div.dataset.text.includes(f)) ? '' : 'none';
  }
});

// SSE log stream
let es;
function connectSSE() {
  es = new EventSource('/dashboard/logs');
  document.getElementById('s-dot').className = 'dot on';
  document.getElementById('s-status').textContent = 'Connected';
  es.onmessage = (e) => { try { addLine(JSON.parse(e.data)); } catch {} };
  es.onerror = () => {
    document.getElementById('s-dot').className = 'dot off';
    document.getElementById('s-status').textContent = 'Reconnecting…';
    es.close();
    setTimeout(connectSSE, 3000);
  };
}
connectSSE();

// Status polling
async function pollStatus() {
  try {
    const r = await fetch('/dashboard/api/status');
    const d = await r.json();
    document.getElementById('s-uptime').textContent = formatUptime(d.uptime);
    document.getElementById('s-mem').textContent = formatMB(d.memory.rss);
    document.getElementById('s-sessions').textContent = d.sessions.length;
    document.getElementById('s-pid').textContent = d.pid;
    document.getElementById('s-node').textContent = d.nodeVersion;

    const sessEl = document.getElementById('sessions');
    if (d.sessions.length === 0) {
      sessEl.innerHTML = '<div class="empty">No active sessions</div>';
    } else {
      sessEl.innerHTML = d.sessions.map(s =>
        '<div class="session-item"><div class="sid">' + s.id.slice(0,8) + '…</div>' +
        '<div class="age">' + formatUptime((Date.now() - s.created)/1000) + ' ago</div></div>'
      ).join('');
    }
  } catch {}
}
pollStatus();
setInterval(pollStatus, 5000);

async function api(action) {
  if (!confirm(action === 'stop' ? 'Stop the MCP server?' : 'Restart the MCP server?')) return;
  try {
    const r = await fetch('/dashboard/api/' + action, { method: 'POST' });
    const d = await r.json();
    if (d.note) alert(d.note);
  } catch(e) { alert('Action failed: ' + e.message); }
}
</script>
</body>
</html>`;
//# sourceMappingURL=index.js.map