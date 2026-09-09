/**
 * MCP stdio transport entry.
 *
 * Speaks JSON-RPC over stdin/stdout (StdioServerTransport). Recommended for
 * Grok Bot / Cursor local `command` MCP — no HTTP port, no public network.
 *
 * Important: never write non-protocol data to stdout (console.log is redirected
 * to stderr). HTTP dashboard/logBuffer is not loaded in this path.
 */
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, buildLiteServer } from "./server.js";
// Keep stdout clean for the MCP framing protocol.
console.log = (...args) => {
    console.error(...args);
};
const liteMode = process.env.MCP_LITE === "1";
const debug = process.argv.includes("--debug") || process.env.MCP_DEBUG === "1";
export async function startStdioServer() {
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