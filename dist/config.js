// Central configuration read from environment variables.
function opt(name, fallback = "") {
    return process.env[name] ?? fallback;
}
/**
 * Optional extra allow-filter on tenants (defense in depth).
 * Empty = allow any tenant the caller genuinely has access to (home or guest).
 * Format: "tid1,tid2".
 */
function parseAllowedTenants() {
    return new Set(opt("MCP_ALLOWED_TENANTS")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean));
}
export const config = {
    port: Number(opt("PORT", "3000")),
    nodeEnv: opt("NODE_ENV", "development"),
    publicUrl: opt("MCP_PUBLIC_URL", "http://localhost:3000"),
    debug: process.argv.includes("--debug") || opt("MCP_DEBUG") === "1",
    // Microsoft identity platform + service hosts
    tokenHost: opt("MSFT_HOST", "login.microsoftonline.com"),
    bcApiHost: opt("BC_API_HOST", "api.businesscentral.dynamics.com"),
    armHost: opt("ARM_HOST", "management.azure.com"),
    // OAuth scopes
    bcScope: "https://api.businesscentral.dynamics.com/.default",
    armScope: "https://management.azure.com/.default",
    // The OBO / confidential-client app (resource server).
    bcClientId: opt("BC_CLIENT_ID"),
    bcClientSecret: opt("BC_CLIENT_SECRET"),
    bcTenantId: opt("BC_TENANT_ID"),
    // OAuth resource-server validation: audiences the bearer JWT must carry
    // (e.g. api://<clientId> or <clientId>). Defaults to BC_CLIENT_ID.
    expectedAudiences: opt("MCP_EXPECTED_AUDIENCES", opt("BC_CLIENT_ID"))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    // AES-256-GCM key (64 hex) — MUST match the legacy server so x-origo-token works.
    encryptionKeyHex: opt("MCP_ENCRYPTION_KEY"),
    defaultEnvironment: opt("BC_ENVIRONMENT", "production"),
    allowedTenants: parseAllowedTenants(),
};
export function getEncryptionKey() {
    const hex = config.encryptionKeyHex;
    if (!hex || hex.length !== 64) {
        throw new Error("MCP_ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256-GCM");
    }
    return Buffer.from(hex, "hex");
}
//# sourceMappingURL=config.js.map