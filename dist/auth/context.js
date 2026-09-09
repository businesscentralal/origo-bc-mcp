import { AsyncLocalStorage } from "node:async_hooks";
import { buildStdioAuthContext } from "./devContext.js";
const als = new AsyncLocalStorage();
/**
 * Process-level fallback for stdio: stdin handlers may run outside the ALS
 * tree that started `server.connect`, so HTTP-style `runWithAuth` alone is
 * not enough. HTTP never sets this; stdio installs it at process start.
 *
 * Note: duplicate ESM instances (different resolved paths) each get their own
 * `processFallback`. Stdio sets `MCP_STDIO_AUTH=1` (process-wide) so
 * `getAuthContext` can rebuild from local.settings when fallback/ALS are missing.
 */
let processFallback;
/** True when this process is serving MCP over stdio (set by stdio entry). */
export function isStdioAuthPath() {
    return (process.env.MCP_STDIO_AUTH === "1" ||
        process.argv.includes("--stdio") ||
        process.env.MCP_TRANSPORT === "stdio");
}
/** Runs `fn` with the given auth context active for the whole async chain. */
export function runWithAuth(ctx, fn) {
    return als.run(ctx, fn);
}
/**
 * Install a process-wide auth context for stdio (and enter ALS for the
 * current async resource). Clear with `undefined` in tests.
 */
export function setProcessAuthContext(ctx) {
    processFallback = ctx;
    if (ctx) {
        als.enterWith(ctx);
    }
}
/** Current process fallback (stdio), if any — does not rebuild or throw. */
export function getProcessAuthContext() {
    return processFallback;
}
/**
 * Rebuild BC auth from MCP_CONNECTION / local.settings and cache as processFallback.
 * Returns undefined if not on the stdio path or settings cannot be resolved.
 */
export function tryRebuildStdioAuth() {
    if (!isStdioAuthPath())
        return undefined;
    try {
        const ctx = buildStdioAuthContext("stdio");
        processFallback = ctx;
        try {
            als.enterWith(ctx);
        }
        catch {
            // enterWith can fail outside an async resource; runWithAuth still works.
        }
        return ctx;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve auth for the current call: ALS → processFallback → stdio rebuild.
 * Does not throw (returns undefined when nothing is available).
 */
export function resolveAuthContext() {
    return als.getStore() ?? processFallback ?? tryRebuildStdioAuth();
}
/**
 * Re-bind ALS for `fn` using processFallback or a stdio rebuild.
 * If no BC auth is available, runs `fn` unbound (Cosmo tools stay usable).
 */
export function ensureAuthBound(fn) {
    const existing = als.getStore();
    if (existing)
        return fn();
    const ctx = processFallback ?? tryRebuildStdioAuth();
    if (!ctx)
        return fn();
    return als.run(ctx, fn);
}
/** Returns the current auth context. Throws if none is set (tool called without auth). */
export function getAuthContext() {
    const ctx = resolveAuthContext();
    if (!ctx) {
        throw new Error("No auth context — request reached a tool without authentication.");
    }
    return ctx;
}
//# sourceMappingURL=context.js.map