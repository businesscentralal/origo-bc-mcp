import { config } from "../config.js";
import { getAuthContext } from "../auth/context.js";
import { oboToken } from "../auth/entra.js";
const directCache = new Map();
/**
 * Acquires a Business Central access token for `targetTenantId`.
 *  - OAuth caller   -> OBO exchange into the target tenant.
 *  - origo-token    -> refresh_token or client_credentials against the blob tenant.
 *  - accessToken    -> passthrough.
 */
export async function getBcAccessToken(targetTenantId) {
    const ctx = getAuthContext();
    const conn = ctx.conn;
    if (conn.onPrem) {
        throw new Error("On-prem connections use Basic auth, not OAuth tokens. Use onPremAuthHeader / the on-prem request path.");
    }
    if (conn.accessToken)
        return conn.accessToken;
    if (ctx.method === "oauth") {
        if (!conn.bearerToken)
            throw new Error("OAuth context missing bearer token");
        const principal = ctx.principal ?? ctx.homeTenantId;
        return oboToken(conn.bearerToken, principal, targetTenantId, config.bcScope);
    }
    // origo-token path: refresh_token (preferred) or client_credentials.
    if (!conn.clientId)
        throw new Error("origo-token connection missing clientId");
    const useRefresh = !conn.clientSecret && !!conn.refreshToken;
    const cacheKey = `${targetTenantId}|${conn.clientId}|${useRefresh ? "rt" : "cc"}`;
    const cached = directCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry - 60_000)
        return cached.token;
    const body = useRefresh
        ? new URLSearchParams({
            grant_type: "refresh_token",
            client_id: conn.clientId,
            refresh_token: conn.refreshToken,
            scope: `${config.bcScope} offline_access`,
        })
        : new URLSearchParams({
            grant_type: "client_credentials",
            client_id: conn.clientId,
            client_secret: conn.clientSecret,
            scope: config.bcScope,
        });
    const res = await fetch(`https://${config.tokenHost}/${targetTenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const parsed = (await res.json());
    if (parsed.error || !parsed.access_token) {
        throw new Error(`BC token error (${parsed.error ?? "no_token"}): ${parsed.error_description ?? ""}`);
    }
    directCache.set(cacheKey, {
        token: parsed.access_token,
        expiry: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    });
    return parsed.access_token;
}
/** Basic auth header for an on-prem connection. */
export function onPremAuthHeader(conn) {
    return "Basic " + Buffer.from(`${conn.user ?? ""}:${conn.key ?? ""}`).toString("base64");
}
/** Lists companies in a tenant + environment. On-prem returns the configured company. */
export async function listCompanies(tenantId, environment) {
    const ctx = getAuthContext();
    // On-prem: the legacy server derives the company from configuration, not a remote list.
    if (ctx.conn.onPrem) {
        if (!ctx.conn.companyId)
            return [];
        return [
            {
                id: ctx.conn.companyId,
                name: ctx.conn.companyName ?? ctx.conn.companyId,
                displayName: ctx.conn.companyName ?? ctx.conn.companyId,
            },
        ];
    }
    const token = await getBcAccessToken(tenantId);
    const url = `https://${config.bcApiHost}/v2.0/${tenantId}/${environment}/api/v2.0/companies`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        throw new Error(`BC companies request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json());
    return (data.value ?? []).map((c) => ({
        id: String(c.id ?? ""),
        name: String(c.name ?? ""),
        displayName: String(c.displayName ?? c.name ?? ""),
    }));
}
//# sourceMappingURL=client.js.map