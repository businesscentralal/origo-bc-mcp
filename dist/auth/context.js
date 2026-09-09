import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
/**
 * Process-level fallback for stdio: stdin handlers may run outside the ALS
 * tree that started `server.connect`, so HTTP-style `runWithAuth` alone is
 * not enough. HTTP never sets this; stdio installs it at process start.
 */
let processFallback;
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
/** Returns the current auth context. Throws if none is set (tool called without auth). */
export function getAuthContext() {
    const ctx = als.getStore() ?? processFallback;
    if (!ctx) {
        throw new Error("No auth context — request reached a tool without authentication.");
    }
    return ctx;
}
//# sourceMappingURL=context.js.map