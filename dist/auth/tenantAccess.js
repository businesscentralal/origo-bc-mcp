import { config } from "../config.js";
import { getAuthContext } from "./context.js";
import { listAccessibleTenants } from "./entra.js";
import { getSelection, getCachedTenants, cacheTenants } from "../session/store.js";
/** Returns the tenants the current caller may access (cached per principal). */
export async function resolveAccessibleTenants() {
    const ctx = getAuthContext();
    // x-origo-token / basic-dev are bound to exactly one tenant (their connection).
    if (ctx.method !== "oauth") {
        return [{ tenantId: ctx.homeTenantId, displayName: ctx.homeTenantId, category: "Home" }];
    }
    const principal = ctx.principal ?? ctx.homeTenantId;
    const cached = getCachedTenants(principal);
    if (cached)
        return cached;
    if (!ctx.conn.bearerToken) {
        throw new Error("Cannot list tenants: no bearer token on the OAuth context");
    }
    const tenants = await listAccessibleTenants(ctx.conn.bearerToken, principal, ctx.homeTenantId);
    cacheTenants(principal, tenants);
    return tenants;
}
/**
 * CRITICAL guard. Resolves the effective tenant for a call and verifies the
 * caller is genuinely allowed into it. A user must never reach a tenant they
 * have no access to.
 *
 * Resolution order: explicit arg -> session selection -> home tenant.
 */
export async function assertTenantAccess(requestedTenantId) {
    const ctx = getAuthContext();
    const selection = getSelection(ctx.sessionId);
    const target = (requestedTenantId || selection.tenantId || ctx.homeTenantId).trim();
    const targetLc = target.toLowerCase();
    // Optional extra allow-filter (defense in depth).
    if (config.allowedTenants.size > 0 && !config.allowedTenants.has(targetLc)) {
        throw new Error(`Access denied: tenant ${target} is not in MCP_ALLOWED_TENANTS.`);
    }
    // Home tenant is always allowed.
    if (targetLc === ctx.homeTenantId.toLowerCase())
        return target;
    // Non-OAuth methods (x-origo-token, basic-dev) cannot cross tenants.
    if (ctx.method !== "oauth") {
        throw new Error(`Access denied: this ${ctx.method} connection is bound to tenant ${ctx.homeTenantId} and cannot target ${target}.`);
    }
    // OAuth: allowed only if the user genuinely has access (home or guest).
    const tenants = await resolveAccessibleTenants();
    const ok = tenants.some((t) => t.tenantId.toLowerCase() === targetLc);
    if (!ok) {
        throw new Error(`Access denied: you do not have access to tenant ${target}. ` +
            `Use bc_list_tenants to see the tenants available to you.`);
    }
    return target;
}
//# sourceMappingURL=tenantAccess.js.map