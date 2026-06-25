// In-memory per-session state. Fine for a single replica; for multi-replica
// scale-out move this to Redis or rely on sticky sessions / per-call params.
const selections = new Map();
const accessibleTenantsByPrincipal = new Map();
const TENANTS_TTL_MS = 5 * 60_000;
export function getSelection(sessionId) {
    if (!sessionId)
        return {};
    return selections.get(sessionId) ?? {};
}
export function setSelection(sessionId, patch) {
    const next = { ...getSelection(sessionId), ...patch };
    selections.set(sessionId, next);
    return next;
}
export function clearSession(sessionId) {
    selections.delete(sessionId);
}
export function getCachedTenants(principal) {
    const hit = accessibleTenantsByPrincipal.get(principal);
    if (hit && Date.now() < hit.expiry)
        return hit.tenants;
    return undefined;
}
export function cacheTenants(principal, tenants) {
    accessibleTenantsByPrincipal.set(principal, {
        tenants,
        expiry: Date.now() + TENANTS_TTL_MS,
    });
}
//# sourceMappingURL=store.js.map