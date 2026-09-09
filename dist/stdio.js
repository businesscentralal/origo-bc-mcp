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
 * Cursor AddMcpServer may invoke tool handlers outside the ALS/enterWith tree
 * (or hit a duplicate module instance). We therefore:
 *  1. set MCP_STDIO_AUTH=1 (process-wide) so getAuthContext can rebuild;
 *  2. install processFallback + enterWith at startup;
 *  3. wrap the MCP `tools/call` request handler with ensureAuthBound so every
 *     tool invocation (who_am_i, bc_*, …) re-binds ALS for that call.
 *
 * Important: never write non-protocol data to stdout (console.log is redirected
 * to stderr). HTTP dashboard/logBuffer is not loaded in this path.
 */
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureAuthBound, setProcessAuthContext, } from "./auth/context.js";
import { buildStdioAuthContext } from "./auth/devContext.js";
import { getSelection, setSelection } from "./session/store.js";
import { buildServer, buildLiteServer } from "./server.js";
// Keep stdout clean for the MCP framing protocol.
console.log = (...args) => {
    console.error(...args);
};
const liteMode = process.env.MCP_LITE === "1";
const debug = process.argv.includes("--debug") || process.env.MCP_DEBUG === "1";
/**
 * Wrap the SDK `tools/call` handler so every tool invocation re-enters ALS
 * with processFallback (or a stdio rebuild). Cosmo tools still run when BC
 * auth cannot be resolved (ensureAuthBound is a no-op then).
 */
export function installCallToolAuthBinder(server) {
    const proto = server.server;
    const prev = proto._requestHandlers?.get("tools/call");
    if (!prev) {
        return false;
    }
    proto._requestHandlers.set("tools/call", (request, extra) => Promise.resolve(ensureAuthBound(() => prev(request, extra))));
    return true;
}
function installStdioAuth() {
    // Process-wide flag: survives duplicate ESM instances of auth/context.js.
    process.env.MCP_STDIO_AUTH = "1";
    process.env.MCP_TRANSPORT = "stdio";
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
    const bound = installCallToolAuthBinder(server);
    if (debug) {
        console.error(`[MCP] tools/call auth binder ${bound ? "installed" : "SKIPPED (handler missing)"}`);
    }
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