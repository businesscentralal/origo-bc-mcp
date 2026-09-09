/**
 * Build AuthContext from a local.settings DevConnection.
 * Shared by HTTP Basic middleware and stdio (no HTTP headers).
 */
import { config } from "../config.js";
import { getConnection, getLocalSettings, listConnectionNames } from "../config/localSettings.js";
/**
 * Resolve a DevConnection into the same AuthContext shape HTTP Basic produces.
 * Does not require Basic credentials — used by stdio and after Basic validation.
 */
export function buildDevConnectionContext(opts = {}) {
    const connectionName = opts.connectionName;
    const dc = getConnection(connectionName);
    if (!dc) {
        const available = listConnectionNames();
        const msg = connectionName && connectionName !== "default"
            ? `Connection "${connectionName}" not found in local.settings.json` +
                (available.length ? ` (available: ${available.join(", ")})` : "")
            : "devConnection is missing in local.settings.json (required for stdio BC tools, or set MCP_CONNECTION to a named connection)";
        throw new Error(msg);
    }
    const principal = opts.principal ?? "stdio";
    const sessionId = opts.sessionId;
    // On-prem / container (Basic auth against a BC REST base URL).
    if (dc.onPrem || dc.baseUrl) {
        if (!dc.baseUrl || !dc.user || !dc.key) {
            throw new Error("On-prem devConnection requires baseUrl, user and key in local.settings.json");
        }
        const onPremTenant = dc.onPremTenant ?? "default";
        return {
            method: "basic",
            homeTenantId: onPremTenant,
            principal,
            sessionId,
            conn: {
                tenantId: onPremTenant,
                environment: dc.environment ?? "onprem",
                onPrem: true,
                baseUrl: dc.baseUrl,
                developerBaseUrl: dc.developerBaseUrl,
                onPremTenant,
                user: dc.user,
                key: dc.key,
                companyId: dc.companyId,
                companyName: dc.companyName,
            },
        };
    }
    // SaaS (Entra: refresh token or client credentials).
    if (!dc.tenantId || !dc.clientId) {
        throw new Error("SaaS devConnection requires tenantId + clientId in local.settings.json");
    }
    return {
        method: "basic",
        homeTenantId: dc.tenantId,
        principal,
        sessionId,
        conn: {
            tenantId: dc.tenantId,
            environment: dc.environment ?? config.defaultEnvironment,
            clientId: dc.clientId,
            authType: dc.authType,
            clientSecret: dc.clientSecret,
            refreshToken: dc.refreshToken,
            companyId: dc.companyId,
            companyName: dc.companyName,
        },
    };
}
/**
 * Stdio auth: load connection from MCP_CONNECTION (default: "default" → devConnection).
 * Prefers MCP_LOCAL_SETTINGS_PATH / local.settings; Cosmo stays independent (no BC auth).
 */
export function buildStdioAuthContext(sessionId) {
    const connectionName = process.env.MCP_CONNECTION?.trim() || "default";
    const ls = getLocalSettings();
    const principal = ls.basicAuth?.username?.trim() || "stdio";
    return buildDevConnectionContext({
        connectionName,
        principal,
        sessionId: sessionId ?? "stdio",
    });
}
//# sourceMappingURL=devContext.js.map