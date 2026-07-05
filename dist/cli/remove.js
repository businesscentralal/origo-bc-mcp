/**
 * CLI commands for removing connections and cleaning config.
 *
 * Usage:
 *   origo-bc-mcp-server remove <name>   — remove a specific named connection
 *   origo-bc-mcp-server clean           — remove ALL connections and reset config
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";
import { findAllShortcuts } from "./setup.js";
// ── Paths ────────────────────────────────────────────────────────────────────
function getVSCodeMcpPath() {
    switch (platform()) {
        case "win32":
            return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "mcp.json");
        case "darwin":
            return join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json");
        default:
            return join(homedir(), ".config", "Code", "User", "mcp.json");
    }
}
function findSettingsPath() {
    const cwdConfig = resolve(process.cwd(), "config", "local.settings.json");
    if (existsSync(cwdConfig))
        return cwdConfig;
    const globalConfig = join(homedir(), ".origo-bc-mcp", "local.settings.json");
    if (existsSync(globalConfig))
        return globalConfig;
    return null;
}
function readJson(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return null;
    }
}
function writeJson(path, data) {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${question} [y/N]: `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}
// ── List connections ─────────────────────────────────────────────────────────
function listConnections(settings) {
    const names = [];
    if (settings.devConnection)
        names.push("default");
    if (settings.connections) {
        names.push(...Object.keys(settings.connections));
    }
    return names;
}
// ── Remove a single connection ───────────────────────────────────────────────
export async function runRemove(name) {
    const settingsPath = findSettingsPath();
    if (!settingsPath) {
        console.log("No local.settings.json found. Nothing to remove.");
        process.exit(0);
    }
    const settings = readJson(settingsPath);
    if (!settings) {
        console.log("Could not parse local.settings.json.");
        process.exit(1);
    }
    const available = listConnections(settings);
    if (!name) {
        if (available.length === 0) {
            console.log("No connections configured.");
            process.exit(0);
        }
        console.log("\nConfigured connections:");
        available.forEach((n) => console.log(`  • ${n}`));
        console.log("\nUsage: origo-bc-mcp-server remove <name>");
        process.exit(0);
    }
    // Check if connection exists
    if (name === "default") {
        if (!settings.devConnection) {
            console.log(`Connection "default" not found.`);
            console.log(`Available: ${available.join(", ") || "(none)"}`);
            process.exit(1);
        }
    }
    else {
        if (!settings.connections?.[name]) {
            console.log(`Connection "${name}" not found.`);
            console.log(`Available: ${available.join(", ") || "(none)"}`);
            process.exit(1);
        }
    }
    const yes = await confirm(`Remove connection "${name}"?`);
    if (!yes) {
        console.log("Cancelled.");
        process.exit(0);
    }
    // Remove from local settings
    if (name === "default") {
        delete settings.devConnection;
    }
    else {
        delete settings.connections[name];
        if (Object.keys(settings.connections).length === 0) {
            delete settings.connections;
        }
    }
    writeJson(settingsPath, settings);
    console.log(`✓ Connection "${name}" removed from ${settingsPath}`);
    // Remove from VS Code mcp.json
    const mcpPath = getVSCodeMcpPath();
    const mcpConfig = readJson(mcpPath);
    if (mcpConfig?.servers) {
        const serverName = name === "default" ? "origo-bc-local" : `origo-bc-${name}`;
        if (mcpConfig.servers[serverName]) {
            delete mcpConfig.servers[serverName];
            writeJson(mcpPath, mcpConfig);
            console.log(`✓ Server "${serverName}" removed from ${mcpPath}`);
        }
    }
    console.log("");
}
// ── Clean all config ─────────────────────────────────────────────────────────
export async function runClean() {
    const settingsPath = findSettingsPath();
    const mcpPath = getVSCodeMcpPath();
    console.log("\nThis will remove:");
    if (settingsPath) {
        const settings = readJson(settingsPath);
        const conns = settings ? listConnections(settings) : [];
        console.log(`  • ${settingsPath}`);
        if (conns.length > 0) {
            console.log(`    Connections: ${conns.join(", ")}`);
        }
    }
    else {
        console.log("  • (no local.settings.json found)");
    }
    const mcpConfig = readJson(mcpPath);
    const origoServers = mcpConfig?.servers
        ? Object.keys(mcpConfig.servers).filter((k) => k.startsWith("origo-bc-"))
        : [];
    if (origoServers.length > 0) {
        console.log(`  • MCP server entries: ${origoServers.join(", ")}`);
    }
    const shortcuts = findAllShortcuts();
    if (shortcuts.length > 0) {
        console.log(`  • Desktop shortcuts: ${shortcuts.length}`);
        shortcuts.forEach((s) => console.log(`    ${s}`));
    }
    console.log("");
    const yes = await confirm("Remove all origo-bc-mcp-server configuration?");
    if (!yes) {
        console.log("Cancelled.");
        process.exit(0);
    }
    // Delete local settings file
    if (settingsPath && existsSync(settingsPath)) {
        unlinkSync(settingsPath);
        console.log(`✓ Deleted ${settingsPath}`);
    }
    // Remove origo-bc-* entries from mcp.json (but don't delete the whole file)
    if (mcpConfig?.servers && origoServers.length > 0) {
        for (const name of origoServers) {
            delete mcpConfig.servers[name];
        }
        writeJson(mcpPath, mcpConfig);
        console.log(`✓ Removed ${origoServers.length} server entries from ${mcpPath}`);
    }
    // Remove desktop shortcuts
    if (shortcuts.length > 0) {
        for (const shortcut of shortcuts) {
            try {
                unlinkSync(shortcut);
            }
            catch { /* non-fatal */ }
        }
        console.log(`✓ Removed ${shortcuts.length} desktop shortcut(s)`);
    }
    console.log("\n  Run 'origo-bc-mcp-server setup' to reconfigure.\n");
}
//# sourceMappingURL=remove.js.map