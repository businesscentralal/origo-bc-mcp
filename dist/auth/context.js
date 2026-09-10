import { AsyncLocalStorage } from "node:async_hooks";
import { buildStdioAuthContext } from "./devContext.js";
const als = new AsyncLocalStorage();
/**
 * Cross-module stdio auth store.
 *
 * Cursor AddMcpServer can resolve `auth/context.js` twice (different absolute
 * paths / package copies). Module-local `processFallback` then diverges:
 * stdio.js sets instance A, tool handlers read instance B → "No auth context".
 * `globalThis` is shared across all ESM graphs in the same Node realm.
 */
const GLOBAL_KEY = "__origoBcMcpStdioAuth__";
function globalStore() {
    const g = globalThis;
    if (!g[GLOBAL_KEY])
        g[GLOBAL_KEY] = {};
    return g[GLOBAL_KEY];
}
/** Module-local mirror (fast path when the same instance is used throughout). */
let processFallback;
/** True when this process is serving MCP over stdio (set by stdio entry). */
export function isStdioAuthPath() {
    return (process.env.MCP_STDIO_AUTH === "1" ||
        process.argv.includes("--stdio") ||
        process.env.MCP_TRANSPORT === "stdio" ||
        Boolean(globalStore().enabled));
}
/** Runs `fn` with the given auth context active for the whole async chain. */
export function runWithAuth(ctx, fn) {
    return als.run(ctx, fn);
}
/**
 * Install a process-wide auth context for stdio (module-local + globalThis).
 * Clear with `undefined` in tests.
 */
export function setProcessAuthContext(ctx) {
    processFallback = ctx;
    const g = globalStore();
    if (ctx) {
        g.ctx = ctx;
        g.enabled = true;
        process.env.MCP_STDIO_AUTH = "1";
        try {
            als.enterWith(ctx);
        }
        catch {
            // enterWith can fail outside an async resource; runWithAuth still works.
        }
    }
    else {
        delete g.ctx;
        g.enabled = false;
    }
}
/** Current process fallback (stdio), if any — does not rebuild or throw. */
export function getProcessAuthContext() {
    return processFallback ?? globalStore().ctx;
}
/**
 * Rebuild BC auth from MCP_CONNECTION / local.settings and cache locally + globalThis.
 * Returns undefined if not on the stdio path or settings cannot be resolved.
 * Any duplicate module instance can recover via this path.
 */
export function tryRebuildStdioAuth() {
    if (!isStdioAuthPath())
        return undefined;
    try {
        const ctx = buildStdioAuthContext("stdio");
        setProcessAuthContext(ctx);
        return ctx;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve auth for the current call:
 * ALS → module fallback → globalThis → stdio rebuild from local.settings.
 */
export function resolveAuthContext() {
    return (als.getStore() ??
        processFallback ??
        globalStore().ctx ??
        tryRebuildStdioAuth());
}
/**
 * Re-bind ALS for `fn` using shared fallback or a stdio rebuild.
 * If no BC auth is available, runs `fn` unbound (Cosmo tools stay usable).
 */
export function ensureAuthBound(fn) {
    const existing = als.getStore();
    if (existing)
        return fn();
    const ctx = processFallback ?? globalStore().ctx ?? tryRebuildStdioAuth();
    if (!ctx)
        return fn();
    return als.run(ctx, fn);
}
/**
 * Wrap a tool callback so every invocation re-enters ALS with shared/rebuild auth.
 * Register-time wrapping keeps Cosmo tools working when BC auth is absent.
 */
export function withStdioAuth(fn) {
    return (...args) => ensureAuthBound(() => fn(...args));
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