import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authMiddleware } from "./auth/middleware.js";
import { buildServer } from "./server.js";
import { clearSession } from "./session/store.js";
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
        let transport;
        if (sessionId && transports[sessionId]) {
            // Resume an existing stateful session.
            transport = transports[sessionId];
        }
        else {
            // No matching session — create a new transport.
            // If the client sent a session ID it will be replaced with a fresh one;
            // if no session ID was sent the server runs stateless (no Mcp-Session-Id returned).
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    transports[sid] = transport;
                },
            });
            transport.onclose = () => {
                if (transport.sessionId) {
                    clearSession(transport.sessionId);
                    delete transports[transport.sessionId];
                }
            };
            const server = buildServer();
            await server.connect(transport);
        }
        await transport.handleRequest(req, res, req.body);
    }
    catch (err) {
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
app.listen(config.port, () => {
    console.log(`origo-bc-mcp listening on :${config.port} (${config.nodeEnv})`);
    console.log(`  MCP endpoint:    ${config.publicUrl}/mcp`);
    console.log(`  Health:          ${config.publicUrl}/healthz`);
});
//# sourceMappingURL=index.js.map