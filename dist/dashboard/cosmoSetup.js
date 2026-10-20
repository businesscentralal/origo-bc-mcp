/**
 * COSMO settings helpers for the dashboard setup page.
 *
 * Pure functions over a LocalSettings object (no file I/O) so they can be unit-tested.
 * The bearer token is only ever written encrypted (AES-256-GCM via MCP_ENCRYPTION_KEY,
 * else Windows DPAPI, else macOS Keychain) or as an `env:` reference. It is never
 * returned by any status function.
 */
import { encryptSecret, wrapDpapi, writeKeychain } from "../config/resolveSecret.js";
export const COSMO_API_PATH_SUFFIX = "/api/alpaca/release";
/** https only, no credentials/query/hash, and the Alpaca API base path (`.../api/alpaca/release`). */
export function validateCosmoBackendUrl(input) {
    const raw = (input ?? "").trim();
    if (!raw)
        return { ok: false, error: "Backend URL is empty." };
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return { ok: false, error: "Backend URL is not a valid URL." };
    }
    if (u.protocol !== "https:")
        return { ok: false, error: "Backend URL must use https." };
    if (u.username || u.password)
        return { ok: false, error: "Backend URL must not contain credentials." };
    if (u.search || u.hash)
        return { ok: false, error: "Backend URL must not contain a query string or fragment." };
    const path = u.pathname.replace(/\/+$/, "");
    if (!path.toLowerCase().endsWith(COSMO_API_PATH_SUFFIX)) {
        return {
            ok: false,
            error: `Backend URL must be the Alpaca API base ending in ${COSMO_API_PATH_SUFFIX} (not the bare public host).`,
        };
    }
    return { ok: true, url: `${u.origin}${path}` };
}
/** Name of the encryption method that would be used for a new token, or undefined if none is available. */
export function cosmoEncryptionMethod() {
    const hex = process.env.MCP_ENCRYPTION_KEY;
    if (hex && hex.length === 64)
        return "aes";
    if (process.platform === "win32")
        return "dpapi";
    if (process.platform === "darwin")
        return "keychain";
    return undefined;
}
/**
 * Encrypts a bearer token for storage. Throws when no encryption is available;
 * unlike connection secrets, the COSMO token is never stored as `plain:`.
 */
export function encryptCosmoToken(token) {
    const aes = encryptSecret(token);
    if (aes)
        return aes;
    if (process.platform === "win32")
        return wrapDpapi(token);
    if (process.platform === "darwin")
        return writeKeychain("origo-bc-mcp-cosmo-bearerToken", token);
    throw new Error("No encryption available on this host. Set MCP_ENCRYPTION_KEY (64 hex chars) and restart, " +
        "or supply the token through the COSMO_BEARER_TOKEN environment variable.");
}
function classifyStored(value) {
    const v = value.trim();
    if (v.startsWith("aes:"))
        return "aes";
    if (v.startsWith("dpapi:"))
        return "dpapi";
    if (v.startsWith("keychain:"))
        return "keychain";
    if (v.startsWith("env:"))
        return "env-reference";
    if (v.startsWith("plain:"))
        return "plain";
    return "literal";
}
/** Status for the UI. Never contains the token (or any part of it). */
export function getCosmoSetupStatus(settings) {
    const stored = settings.cosmo?.bearerToken;
    const tokenSet = typeof stored === "string" && stored.trim().length > 0;
    const tokenStorage = tokenSet ? classifyStored(stored) : undefined;
    return {
        backendUrl: settings.cosmo?.backendUrl || undefined,
        tokenSet,
        tokenStorage,
        tokenInsecure: tokenStorage === "plain" || tokenStorage === "literal",
        envTokenOverride: Boolean(process.env.COSMO_BEARER_TOKEN?.trim()),
        envUrlOverride: Boolean(process.env.COSMO_BACKEND_URL?.trim()),
    };
}
/**
 * Applies a save request to `settings` in place. Throws Error with a user-safe message
 * (never containing the token) on invalid input.
 */
export function applyCosmoSave(settings, input) {
    const cosmo = { ...(settings.cosmo ?? {}) };
    if (input.backendUrl !== undefined) {
        const trimmed = input.backendUrl.trim();
        if (!trimmed) {
            delete cosmo.backendUrl;
        }
        else {
            const v = validateCosmoBackendUrl(trimmed);
            if (!v.ok)
                throw new Error(v.error);
            cosmo.backendUrl = v.url;
        }
    }
    const token = input.bearerToken?.trim();
    if (token) {
        // `env:VAR` references are stored as-is (and keep working); anything else is encrypted.
        cosmo.bearerToken = token.startsWith("env:") ? token : encryptCosmoToken(token);
    }
    else if (input.clearToken) {
        delete cosmo.bearerToken;
    }
    if (Object.keys(cosmo).length === 0) {
        delete settings.cosmo;
    }
    else {
        settings.cosmo = cosmo;
    }
}
//# sourceMappingURL=cosmoSetup.js.map