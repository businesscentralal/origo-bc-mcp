// Log buffer must be imported first — it intercepts console.log/error/warn.
import "./dashboard/logBuffer.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authMiddleware } from "./auth/middleware.js";
import { buildServer, buildLiteServer } from "./server.js";
import { clearSession } from "./session/store.js";
import { dashboardRouter, setSessionTracker } from "./dashboard/index.js";
import { ollamaProxyRouter } from "./ollama/proxy.js";
const debug = config.debug;
const liteMode = process.env.MCP_LITE === "1";
function log(...args) {
    if (debug)
        console.log("[MCP]", ...args);
}
function createServer() {
    return liteMode ? buildLiteServer() : buildServer();
}
const app = express();
app.use(express.json({ limit: "8mb" }));
// --- Unauthenticated metadata / health ------------------------------------
app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "origo-bc-mcp", env: config.nodeEnv });
});
// OAuth 2.1 Protected Resource Metadata — lets claude.ai discover the auth server.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
        resource: config.publicUrl,
        authorization_servers: [`https://${config.tokenHost}/common/v2.0`],
        bearer_methods_supported: ["header"],
        scopes_supported: [config.bcScope],
    });
});
// --- Streamable HTTP transport (stateful sessions) ------------------------
const transports = {};
app.post("/mcp", authMiddleware, async (req, res) => {
    try {
        const sessionId = req.headers["mcp-session-id"];
        const body = req.body;
        const method = body?.method || "(no method)";
        const params = body?.params;
        log(`POST session=${sessionId || "NEW"} method=${method}`, params?.name ? `tool=${params.name}` : "", debug && params?.arguments ? `args=${JSON.stringify(params.arguments).slice(0, 200)}` : "");
        let transport;
        if (sessionId && transports[sessionId]) {
            // Resume an existing stateful session.
            transport = transports[sessionId];
        }
        else if (method === "initialize") {
            // Normal MCP handshake — create a stateful transport.
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    log(`Session initialized: ${sid}`);
                    transports[sid] = transport;
                },
            });
            transport.onclose = () => {
                if (transport.sessionId) {
                    log(`Session closed: ${transport.sessionId}`);
                    clearSession(transport.sessionId);
                    delete transports[transport.sessionId];
                }
            };
            const server = createServer();
            await server.connect(transport);
        }
        else {
            // Client skipped initialize (e.g. Open WebUI) — use stateless mode.
            log(`Stateless fallback for method=${method} (no initialize received)`);
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // stateless — no session validation
            });
            const server = createServer();
            await server.connect(transport);
        }
        await transport.handleRequest(req, res, req.body);
    }
    catch (err) {
        console.error("[MCP] Error:", err.message);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: `Internal error: ${err.message}` },
                id: null,
            });
        }
    }
});
// GET (server-sent stream) and DELETE (session teardown) reuse the session.
async function sessionRequest(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session id");
        return;
    }
    await transports[sessionId].handleRequest(req, res);
}
app.get("/mcp", authMiddleware, sessionRequest);
app.delete("/mcp", authMiddleware, sessionRequest);
// --- Dashboard (no auth — internal use) -----------------------------------
setSessionTracker(() => Object.entries(transports).map(([id, t]) => ({
    id,
    created: t._createdAt ?? Date.now(),
})));
app.use("/dashboard", dashboardRouter);
// --- Ollama proxy (normalizes tool call arguments) ------------------------
app.use("/ollama", ollamaProxyRouter);
app.listen(config.port, () => {
    console.log(`origo-bc-mcp listening on :${config.port} (${config.nodeEnv}${liteMode ? ", LITE" : ""})`);
    console.log(`  MCP endpoint:    ${config.publicUrl}/mcp`);
    console.log(`  Dashboard:       ${config.publicUrl}/dashboard`);
    console.log(`  Health:          ${config.publicUrl}/healthz`);
    if (liteMode)
        console.log(`  LITE MODE:       reduced tool set for local LLMs`);
    if (debug)
        console.log(`  DEBUG MODE:      enabled (all requests/responses logged)`);
});
//# sourceMappingURL=index.js.map