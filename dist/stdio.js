/**
 * MCP stdio transport entry.
 *
 * Speaks JSON-RPC over stdin/stdout (StdioServerTransport). Recommended for
 * Grok Bot / Cursor local `command` MCP — no HTTP port, no public network.
 *
 * Auth: HTTP middleware never runs on this path. Before tools execute we
 * install a process auth context from local.settings (`devConnection` or
 * `connections[MCP_CONNECTION]`), same shape as Basic → buildDevConnectionContext.
 * Cosmo tools do not need this context (Bearer via env / gh independently).
 *
 * Important: never write non-protocol data to stdout (console.log is redirected
 * to stderr). HTTP dashboard/logBuffer is not loaded in this path.
 */
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setProcessAuthContext } from "./auth/context.js";
import { buildStdioAuthContext } from "./auth/devContext.js";
import { getSelection, setSelection } from "./session/store.js";
import { buildServer, buildLiteServer } from "./server.js";
// Keep stdout clean for the MCP framing protocol.
console.log = (...args) => {
    console.error(...args);
};
const liteMode = process.env.MCP_LITE === "1";
const debug = process.argv.includes("--debug") || process.env.MCP_DEBUG === "1";
function installStdioAuth() {
    const ctx = buildStdioAuthContext("stdio");
    setProcessAuthContext(ctx);
    // Mirror HTTP middleware: seed session selection from connection config.
    if (ctx.sessionId && ctx.conn.tenantId) {
        const sel = getSelection(ctx.sessionId);
        if (!sel.tenantId && !sel.environment && !sel.companyId) {
            setSelection(ctx.sessionId, {
                tenantId: ctx.conn.tenantId,
                environment: ctx.conn.environment,
                companyId: ctx.conn.companyId,
                companyName: ctx.conn.companyName,
            });
        }
    }
    if (debug) {
        const name = process.env.MCP_CONNECTION?.trim() || "default";
        console.error(`[MCP] stdio auth context ready (connection=${name}, method=${ctx.method}, env=${ctx.conn.environment}, onPrem=${Boolean(ctx.conn.onPrem)})`);
    }
}
export async function startStdioServer() {
    installStdioAuth();
    const server = liteMode ? buildLiteServer() : buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    if (debug) {
        console.error(`[MCP] stdio transport ready (${liteMode ? "LITE" : "full"} tool set)`);
    }
}
const isDirect = typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
    startStdioServer().catch((err) => {
        console.error("[MCP] stdio failed:", err.message);
        process.exit(1);
    });
}
//# sourceMappingURL=stdio.js.map