import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
/** Runs `fn` with the given auth context active for the whole async chain. */
export function runWithAuth(ctx, fn) {
    return als.run(ctx, fn);
}
/** Returns the current auth context. Throws if none is set (tool called without auth). */
export function getAuthContext() {
    const ctx = als.getStore();
    if (!ctx) {
        throw new Error("No auth context — request reached a tool without authentication.");
    }
    return ctx;
}
//# sourceMappingURL=context.js.map