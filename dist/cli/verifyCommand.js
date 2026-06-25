/**
 * Standalone connection verification command.
 * Validates one or all configured connections, with device-code re-auth for expired tokens.
 *
 * Usage:
 *   origo-bc-mcp-server verify             — verify all connections
 *   origo-bc-mcp-server verify production   — verify a specific named connection
 *   origo-bc-mcp-server verify default      — verify the default devConnection
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { resolveSecret } from "../config/resolveSecret.js";
import { validateConnection } from "./validate.js";
function findSettingsPath() {
    const cwdConfig = resolve(process.cwd(), "config", "local.settings.json");
    if (existsSync(cwdConfig))
        return cwdConfig;
    const globalConfig = join(homedir(), ".origo-bc-mcp", "local.settings.json");
    if (existsSync(globalConfig))
        return globalConfig;
    throw new Error("No local.settings.json found.\n" +
        "  Run 'origo-bc-mcp-server setup' to create one, or use --config <path>.");
}
function loadSettings(path) {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
}
function resolveConnSecrets(conn) {
    const copy = { ...conn };
    if (typeof copy.clientSecret === "string")
        copy.clientSecret = resolveSecret(copy.clientSecret);
    if (typeof copy.refreshToken === "string")
        copy.refreshToken = resolveSecret(copy.refreshToken);
    if (typeof copy.key === "string")
        copy.key = resolveSecret(copy.key);
    return copy;
}
export async function runVerify(name) {
    const settingsPath = process.env.MCP_LOCAL_SETTINGS_PATH ?? findSettingsPath();
    console.log(`\n  Config: ${settingsPath}\n`);
    const settings = loadSettings(settingsPath);
    // Build list of connections to verify.
    const targets = [];
    if (name) {
        if (name === "default") {
            if (!settings.devConnection) {
                console.error("  ✗ No devConnection configured.");
                process.exit(1);
            }
            targets.push({ name: "default", raw: settings.devConnection });
        }
        else {
            const conn = settings.connections?.[name];
            if (!conn) {
                console.error(`  ✗ Connection "${name}" not found.`);
                const available = listNames(settings);
                if (available.length)
                    console.error(`  Available: ${available.join(", ")}`);
                process.exit(1);
            }
            targets.push({ name, raw: conn });
        }
    }
    else {
        // Verify all.
        if (settings.devConnection)
            targets.push({ name: "default", raw: settings.devConnection });
        if (settings.connections) {
            for (const [k, v] of Object.entries(settings.connections)) {
                if (k.startsWith("_"))
                    continue; // skip _comment entries
                targets.push({ name: k, raw: v });
            }
        }
        if (targets.length === 0) {
            console.error("  ✗ No connections configured. Run 'origo-bc-mcp-server setup'.");
            process.exit(1);
        }
    }
    console.log(`  Verifying ${targets.length} connection${targets.length > 1 ? "s" : ""}...\n`);
    let anyFailed = false;
    let settingsChanged = false;
    for (const target of targets) {
        process.stdout.write(`  [${target.name}] `);
        const resolved = resolveConnSecrets(target.raw);
        let result;
        try {
            result = await validateConnection(resolved, { allowDeviceCode: true });
        }
        catch (e) {
            console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
            anyFailed = true;
            continue;
        }
        if (result.ok) {
            const count = result.companies?.length ?? 0;
            console.log(`✓ ${count} ${count === 1 ? "company" : "companies"}`);
            if (result.companies?.length) {
                result.companies.slice(0, 3).forEach((c) => console.log(`       • ${c.name}`));
                if (result.companies.length > 3)
                    console.log(`       ... +${result.companies.length - 3} more`);
            }
        }
        else {
            console.log(`✗ ${result.error}`);
            anyFailed = true;
        }
        // If a refresh token was renewed, update it in settings.
        if (result.newRefreshToken) {
            console.log(`       ⟳ Refresh token updated`);
            // Store the new token in the raw connection (unresolved form stays as-is if it was env:).
            const rawToken = target.raw.refreshToken;
            if (typeof rawToken === "string" && rawToken.startsWith("env:")) {
                // Can't write back to env var from here — inform the user.
                const envVar = rawToken.slice(4);
                console.log(`       ⚠ Update env var ${envVar} with the new token.`);
                console.log(`         New token: ${result.newRefreshToken.slice(0, 20)}...`);
            }
            else {
                // Write directly to settings (plain text or dpapi).
                target.raw.refreshToken = result.newRefreshToken;
                if (target.name === "default" && settings.devConnection) {
                    settings.devConnection.refreshToken = result.newRefreshToken;
                }
                else if (settings.connections?.[target.name]) {
                    settings.connections[target.name].refreshToken = result.newRefreshToken;
                }
                settingsChanged = true;
            }
        }
    }
    // Persist settings if refresh tokens were renewed.
    if (settingsChanged) {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        console.log(`\n  ✓ Settings updated: ${settingsPath}`);
    }
    console.log("");
    process.exit(anyFailed ? 1 : 0);
}
function listNames(settings) {
    const names = [];
    if (settings.devConnection)
        names.push("default");
    if (settings.connections) {
        for (const k of Object.keys(settings.connections)) {
            if (!k.startsWith("_"))
                names.push(k);
        }
    }
    return names;
}
//# sourceMappingURL=verifyCommand.js.map