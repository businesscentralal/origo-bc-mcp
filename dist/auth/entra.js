import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import { config } from "../config.js";
// Multi-tenant JWKS (covers any tenant that signs in).
const JWKS = createRemoteJWKSet(new URL(`https://${config.tokenHost}/common/discovery/v2.0/keys`));
/**
 * Validates an incoming bearer JWT (the claude.ai OAuth access token).
 * Verifies signature, audience, and that the issuer matches the token's tenant.
 */
export async function verifyBearer(token) {
    const { payload } = await jwtVerify(token, JWKS, {
        audience: config.expectedAudiences.length ? config.expectedAudiences : undefined,
    });
    const tid = String(payload.tid ?? "");
    if (!tid)
        throw new Error("Bearer token has no tid (tenant) claim");
    const iss = String(payload.iss ?? "");
    const okIssuer = iss === `https://${config.tokenHost}/${tid}/v2.0` ||
        iss === `https://sts.windows.net/${tid}/`;
    if (!okIssuer) {
        throw new Error(`Bearer token issuer ${iss} does not match its tenant ${tid}`);
    }
    return payload;
}
const oboCache = new Map();
/**
 * On-Behalf-Of exchange: trades the caller's bearer assertion for a token in
 * `targetTenantId` with the requested `scope`. Works for the home tenant always,
 * and for guest tenants where the app is provisioned/consented.
 */
export async function oboToken(assertion, principal, targetTenantId, scope) {
    const key = `obo|${targetTenantId}|${principal}|${scope}`;
    const cached = oboCache.get(key);
    if (cached && Date.now() < cached.expiry - 60_000)
        return cached.token;
    if (!config.bcClientId || !config.bcClientSecret) {
        throw new Error("OBO requires BC_CLIENT_ID and BC_CLIENT_SECRET to be configured");
    }
    const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        client_id: config.bcClientId,
        client_secret: config.bcClientSecret,
        assertion,
        scope,
        requested_token_use: "on_behalf_of",
    });
    const res = await fetch(`https://${config.tokenHost}/${targetTenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const parsed = (await res.json());
    if (parsed.error || !parsed.access_token) {
        throw new Error(`OBO exchange failed for tenant ${targetTenantId} (${parsed.error ?? "no_token"}): ${parsed.error_description ?? ""}`);
    }
    oboCache.set(key, {
        token: parsed.access_token,
        expiry: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    });
    return parsed.access_token;
}
/**
 * Lists the tenants the signed-in user can access (home + guest), the same set
 * shown on myaccount.microsoft.com. Uses an OBO token for Azure Resource Manager
 * issued by the user's home tenant, then GET /tenants.
 */
export async function listAccessibleTenants(assertion, principal, homeTenantId) {
    const armToken = await oboToken(assertion, principal, homeTenantId, config.armScope);
    const res = await fetch(`https://${config.armHost}/tenants?api-version=2020-01-01`, {
        headers: { Authorization: `Bearer ${armToken}` },
    });
    if (!res.ok) {
        throw new Error(`ARM /tenants failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json());
    return (data.value ?? []).map((t) => ({
        tenantId: t.tenantId,
        displayName: t.displayName ?? t.defaultDomain ?? t.tenantId,
        category: t.tenantCategory ?? (t.tenantId === homeTenantId ? "Home" : "Guest"),
        defaultDomain: t.defaultDomain,
    }));
}
/** Best-effort decode without verification (for principal/tid extraction). */
export function decodeClaims(token) {
    return decodeJwt(token);
}
//# sourceMappingURL=entra.js.map