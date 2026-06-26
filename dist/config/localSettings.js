import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSecret } from "./resolveSecret.js";
let loaded;
export function getLocalSettings() {
    if (loaded)
        return loaded;
    const path = process.env.MCP_LOCAL_SETTINGS_PATH
        ? resolve(process.env.MCP_LOCAL_SETTINGS_PATH)
        : process.env.MCP_DATA_DIR
            ? resolve(process.env.MCP_DATA_DIR, "local.settings.json")
            : resolve(process.cwd(), "config", "local.settings.json");
    try {
        const raw = readFileSync(path, "utf8");
        loaded = JSON.parse(raw);
        // Resolve secret fields (env:, dpapi:, keychain:, aes:, plain:) in devConnection.
        if (loaded.devConnection) {
            const dc = loaded.devConnection;
            dc.clientSecret = resolveSecret(dc.clientSecret);
            dc.refreshToken = resolveSecret(dc.refreshToken);
            dc.key = resolveSecret(dc.key);
        }
        if (loaded.basicAuth) {
            loaded.basicAuth.password = resolveSecret(loaded.basicAuth.password) ?? loaded.basicAuth.password;
        }
        if (loaded.basicAuth?.enabled) {
            console.warn(`[local-settings] Basic auth ENABLED from ${path}`);
        }
    }
    catch {
        loaded = {};
    }
    // Bootstrap basic auth from env vars when not configured in file
    if (!loaded.basicAuth?.enabled && process.env.MCP_ADMIN_USER && process.env.MCP_ADMIN_PASSWORD) {
        loaded.basicAuth = {
            enabled: true,
            username: process.env.MCP_ADMIN_USER,
            password: process.env.MCP_ADMIN_PASSWORD,
        };
        console.warn("[local-settings] Basic auth bootstrapped from MCP_ADMIN_USER/MCP_ADMIN_PASSWORD env vars.");
    }
    return loaded;
}
/**
 * Resolves a named connection from local settings.
 * Falls back to `devConnection` when name is undefined or "default".
 */
export function getConnection(name) {
    const ls = getLocalSettings();
    if (!name || name === "default")
        return ls.devConnection;
    const conn = ls.connections?.[name];
    if (!conn)
        return undefined;
    // Resolve secrets lazily for named connections (idempotent — resolved values pass through).
    if (!resolvedConnections.has(name)) {
        conn.clientSecret = resolveSecret(conn.clientSecret);
        conn.refreshToken = resolveSecret(conn.refreshToken);
        conn.key = resolveSecret(conn.key);
        resolvedConnections.add(name);
    }
    return conn;
}
const resolvedConnections = new Set();
/** Returns the list of available connection names (including "default" if devConnection exists). */
export function listConnectionNames() {
    const ls = getLocalSettings();
    const names = [];
    if (ls.devConnection)
        names.push("default");
    if (ls.connections)
        names.push(...Object.keys(ls.connections));
    return names;
}
/** True only when Basic auth is enabled via local settings. */
export function isBasicAuthEnabled() {
    const ls = getLocalSettings();
    return Boolean(ls.basicAuth?.enabled && ls.basicAuth.username && ls.basicAuth.password);
}
/** Returns the connection name designated as the setup environment, or undefined. */
export function getSetupConnectionName() {
    const ls = getLocalSettings();
    return ls.setupConnection;
}
/** Returns the resolved DevConnection for the setup environment, or undefined. */
export function getSetupConnection() {
    const name = getSetupConnectionName();
    if (!name)
        return undefined;
    return getConnection(name);
}
//# sourceMappingURL=localSettings.js.map