import { config } from "../config.js";
import { getSetupConnection } from "../config/localSettings.js";
/**
 * Resolves the setup connection.
 * Prefers local.settings.json "setupConnection" reference; falls back to SETUP_* env vars.
 */
export function resolveSetupConn() {
    // Try local settings first (dev mode).
    const local = getSetupConnection();
    if (local) {
        return fromDevConnection(local);
    }
    // Fallback: SETUP_* environment variables (production).
    const tenantId = process.env.SETUP_TENANT_ID ?? "";
    const clientId = process.env.SETUP_CLIENT_ID ?? "";
    const clientSecret = process.env.SETUP_CLIENT_SECRET ?? "";
    const companyId = process.env.SETUP_COMPANY_ID ?? "";
    const environment = process.env.SETUP_ENVIRONMENT || "production";
    if (!tenantId || !clientId || !companyId) {
        throw new Error("Setup environment not configured. Either:\n" +
            '  • Set "setupConnection" in local.settings.json to the name of a connection, or\n' +
            "  • Set SETUP_TENANT_ID, SETUP_CLIENT_ID, SETUP_CLIENT_SECRET, SETUP_COMPANY_ID env vars.");
    }
    return { tenantId, clientId, clientSecret, companyId, environment };
}
function fromDevConnection(conn) {
    if (!conn.tenantId || !conn.clientId || !conn.companyId) {
        throw new Error("The setup connection must have tenantId, clientId, and companyId. " +
            "On-prem connections cannot be used as setup.");
    }
    return {
        tenantId: conn.tenantId,
        clientId: conn.clientId,
        clientSecret: conn.clientSecret,
        refreshToken: conn.refreshToken,
        companyId: conn.companyId,
        environment: conn.environment ?? "production",
    };
}
let cached;
/** Acquires a BC access token for the setup environment (client_credentials or refresh_token). */
export async function getSetupAccessToken() {
    if (cached && Date.now() < cached.expiry - 60_000)
        return cached.token;
    const conn = resolveSetupConn();
    const useRefresh = !conn.clientSecret && !!conn.refreshToken;
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
    const res = await fetch(`https://${config.tokenHost}/${conn.tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const parsed = (await res.json());
    if (parsed.error || !parsed.access_token) {
        throw new Error(`Setup token error (${parsed.error ?? "no_token"}): ${parsed.error_description ?? ""}`);
    }
    cached = { token: parsed.access_token, expiry: Date.now() + (parsed.expires_in ?? 3600) * 1000 };
    return parsed.access_token;
}
//# sourceMappingURL=setupConn.js.map