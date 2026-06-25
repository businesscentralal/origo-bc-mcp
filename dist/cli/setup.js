#!/usr/bin/env node
/**
 * Guided setup wizard for origo-bc-mcp-server.
 * Creates/updates:
 *   1. config/local.settings.json (or ~/.origo-bc-mcp/local.settings.json)
 *   2. %APPDATA%/Code/User/mcp.json (VS Code MCP config)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { validateConnection, deviceCodeFlow } from "./validate.js";
import { resolveSecret } from "../config/resolveSecret.js";
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
function getLocalSettingsPath() {
    // Prefer CWD/config if it exists (in-repo dev), else global ~/.origo-bc-mcp/
    const cwdConfig = resolve(process.cwd(), "config", "local.settings.json");
    if (existsSync(cwdConfig))
        return cwdConfig;
    return join(homedir(), ".origo-bc-mcp", "local.settings.json");
}
// ── Interactive helpers ──────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(prompt, defaultValue) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    return new Promise((resolve) => {
        rl.question(`${prompt}${suffix}: `, (answer) => {
            resolve(answer.trim() || defaultValue || "");
        });
    });
}
function askChoice(prompt, choices, defaultIdx = 0) {
    console.log(`\n${prompt}`);
    choices.forEach((c, i) => {
        const marker = i === defaultIdx ? " (default)" : "";
        console.log(`  ${i + 1}) ${c}${marker}`);
    });
    return new Promise((resolve) => {
        rl.question(`Choice [${defaultIdx + 1}]: `, (answer) => {
            const idx = answer.trim() ? parseInt(answer.trim(), 10) - 1 : defaultIdx;
            resolve(choices[idx >= 0 && idx < choices.length ? idx : defaultIdx]);
        });
    });
}
function readLocalSettings(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
function writeJson(path, data) {
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function readMcpConfig(path) {
    if (!existsSync(path))
        return { servers: {} };
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return { servers: {} };
    }
}
// ── Connection validation ────────────────────────────────────────────────────
/**
 * Resolves secret references in a connection object (working copy) and validates.
 * If a refresh token is expired, triggers device-code flow with user consent.
 * Returns the validation result (may contain a newRefreshToken to persist).
 */
async function validateAndUpdate(connection, connName) {
    const doValidate = await askChoice("Validate connection now?", ["Yes", "No (skip)"], 0);
    if (doValidate.startsWith("No"))
        return null;
    console.log("\n  Validating connection...");
    // Build a resolved copy for validation (resolve env:/dpapi:/keychain: references).
    const resolved = { ...connection };
    if (typeof resolved.clientSecret === "string")
        resolved.clientSecret = resolveSecret(resolved.clientSecret);
    if (typeof resolved.refreshToken === "string")
        resolved.refreshToken = resolveSecret(resolved.refreshToken);
    if (typeof resolved.key === "string")
        resolved.key = resolveSecret(resolved.key);
    const result = await validateConnection(resolved, { allowDeviceCode: true });
    if (result.ok) {
        const count = result.companies?.length ?? 0;
        console.log(`  ✓ Connection valid — ${count} ${count === 1 ? "company" : "companies"} accessible.`);
        if (result.companies?.length) {
            result.companies.slice(0, 5).forEach((c) => console.log(`    • ${c.name} (${c.id})`));
            if (result.companies.length > 5)
                console.log(`    ... and ${result.companies.length - 5} more`);
        }
        if (result.newRefreshToken) {
            console.log("\n  ✓ Refresh token updated.");
            connection.refreshToken = await wrapKnownSecret("refresh token", result.newRefreshToken, "BC_DEV_REFRESH_TOKEN", `origo-bc-mcp-${connName}-token`);
        }
    }
    else {
        console.log(`\n  ✗ Validation failed: ${result.error}`);
        const proceed = await askChoice("Save connection anyway?", ["Yes (fix later)", "No (abort)"], 0);
        if (proceed.startsWith("No")) {
            rl.close();
            process.exit(1);
        }
    }
    return result;
}
// ── DPAPI wrap (Windows) ──────────────────────────────────────────────────────
function dpapiWrap(plainText) {
    if (platform() !== "win32") {
        throw new Error("DPAPI is only available on Windows.");
    }
    const script = "$ErrorActionPreference = 'Stop';" +
        "Add-Type -AssemblyName System.Security | Out-Null;" +
        "$stdin = [Console]::In.ReadToEnd();" +
        "$plainBytes = [System.Text.Encoding]::UTF8.GetBytes($stdin);" +
        "try {" +
        "$cipher = [System.Security.Cryptography.ProtectedData]::Protect(" +
        "$plainBytes, $null, " +
        "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)" +
        "} finally {" +
        "for ($i = 0; $i -lt $plainBytes.Length; $i++) { $plainBytes[$i] = 0 }" +
        "}" +
        "[Console]::Out.Write([Convert]::ToBase64String($cipher))";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { input: plainText, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) {
        throw new Error(`DPAPI wrap failed (exit ${result.status})`);
    }
    return "dpapi:" + (result.stdout ?? "").toString().trim();
}
// ── macOS Keychain wrap ──────────────────────────────────────────────────────
function keychainWrap(service, plainText) {
    if (platform() !== "darwin") {
        throw new Error("Keychain is only available on macOS.");
    }
    const account = "mcp-encrypted-conn";
    // Delete any existing entry first (ignore errors if it doesn't exist).
    spawnSync("security", ["delete-generic-password", "-a", account, "-s", service], {
        encoding: "utf8",
    });
    const result = spawnSync("security", ["add-generic-password", "-a", account, "-s", service, "-w", plainText, "-U"], { encoding: "utf8" });
    if (result.status !== 0) {
        const msg = (result.stderr ?? "").trim() || `security exited with ${result.status}`;
        throw new Error(`Keychain write failed: ${msg}`);
    }
    return `keychain:${service}`;
}
// ── Shared secret storage helper ─────────────────────────────────────────────
/**
 * Presents platform-appropriate storage options, collects the secret, and
 * returns the wrapped reference string (env:, dpapi:, keychain:, or plain).
 */
async function askSecretStorage(label, defaultEnvVar, keychainService) {
    const choices = ["Environment variable reference (recommended)"];
    if (platform() === "win32")
        choices.push("DPAPI-encrypted (Windows)");
    if (platform() === "darwin")
        choices.push("macOS Keychain");
    choices.push("Plain text (not recommended)");
    const storeMethod = await askChoice(`How to store the ${label}:`, choices, 0);
    if (storeMethod.startsWith("Environment")) {
        const envVar = await ask("Environment variable name", defaultEnvVar);
        console.log(`\n  ⚠ Make sure to set: $env:${envVar} = "<your-${label}>"\n`);
        return `env:${envVar}`;
    }
    if (storeMethod.startsWith("DPAPI")) {
        const secret = await ask(`${label} (will be encrypted)`);
        const wrapped = dpapiWrap(secret);
        console.log(`  ✓ ${label} DPAPI-encrypted.`);
        return wrapped;
    }
    if (storeMethod.startsWith("macOS")) {
        const service = keychainService ?? `origo-bc-mcp-${defaultEnvVar.toLowerCase()}`;
        const secret = await ask(`${label} (will be stored in Keychain)`);
        const ref = keychainWrap(service, secret);
        console.log(`  ✓ ${label} stored in macOS Keychain (service: ${service}).`);
        return ref;
    }
    // Plain text fallback
    return await ask(`${label} (will be stored in plaintext!)`);
}
/**
 * Wraps an already-known secret value using platform-appropriate storage.
 * Used when the setup flow already has the value (e.g. device-code refresh token).
 */
async function wrapKnownSecret(label, value, defaultEnvVar, keychainService) {
    const choices = ["Environment variable reference (recommended)"];
    if (platform() === "win32")
        choices.push("DPAPI-encrypted (Windows)");
    if (platform() === "darwin")
        choices.push("macOS Keychain");
    choices.push("Plain text (not recommended)");
    const storeMethod = await askChoice(`How to store the new ${label}:`, choices, 0);
    if (storeMethod.startsWith("Environment")) {
        const envVar = await ask("Environment variable name", defaultEnvVar);
        console.log(`\n  ⚠ Set the environment variable now:`);
        console.log(`    [Environment]::SetEnvironmentVariable('${envVar}', '<token>', 'User')`);
        copyToClipboard(value);
        return `env:${envVar}`;
    }
    if (storeMethod.startsWith("DPAPI")) {
        const wrapped = dpapiWrap(value);
        console.log(`  ✓ ${label} DPAPI-encrypted and stored in config.`);
        return wrapped;
    }
    if (storeMethod.startsWith("macOS")) {
        const service = keychainService ?? `origo-bc-mcp-${defaultEnvVar.toLowerCase()}`;
        const ref = keychainWrap(service, value);
        console.log(`  ✓ ${label} stored in macOS Keychain (service: ${service}).`);
        return ref;
    }
    // Plain text
    return value;
}
function copyToClipboard(text) {
    try {
        let cmd, args;
        if (platform() === "win32") {
            cmd = "powershell.exe";
            args = ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"];
        }
        else if (platform() === "darwin") {
            cmd = "pbcopy";
            args = [];
        }
        else {
            cmd = "xclip";
            args = ["-selection", "clipboard"];
        }
        const res = spawnSync(cmd, args, { input: text, encoding: "utf8" });
        if (res.status === 0) {
            console.log("  (Value copied to clipboard)");
            return true;
        }
    }
    catch { /* non-fatal */ }
    console.log(`  Token: ${text}`);
    return false;
}
// ── Desktop shortcut creation ────────────────────────────────────────────────
export function getDesktopPath() {
    if (platform() === "win32") {
        // Query the actual Desktop path (handles OneDrive folder redirection).
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8", windowsHide: true });
        const shellPath = (result.stdout ?? "").trim();
        if (result.status === 0 && shellPath && existsSync(shellPath)) {
            return shellPath;
        }
        // Fallback to USERPROFILE\Desktop.
        return join(process.env.USERPROFILE ?? homedir(), "Desktop");
    }
    return join(homedir(), "Desktop");
}
/** Returns the expected shortcut file path for a given connection name. */
export function getShortcutPath(connectionName) {
    const desktop = getDesktopPath();
    const label = connectionName ? `Origo BC MCP (${connectionName})` : "Origo BC MCP Server";
    if (platform() === "win32") {
        return join(desktop, `${label}.lnk`);
    }
    else if (platform() === "darwin") {
        return join(desktop, `${label}.command`);
    }
    else {
        return join(desktop, `origo-bc-mcp${connectionName ? `-${connectionName}` : ""}.desktop`);
    }
}
/** Removes the desktop shortcut for a given connection name. Returns true if removed. */
export function removeDesktopShortcut(connectionName) {
    const path = getShortcutPath(connectionName);
    if (existsSync(path)) {
        unlinkSync(path);
        return true;
    }
    return false;
}
/** Finds all origo-bc-mcp shortcuts on the Desktop. */
export function findAllShortcuts() {
    const desktop = getDesktopPath();
    if (!existsSync(desktop))
        return [];
    const entries = [];
    try {
        const files = readdirSync(desktop, { encoding: "utf8" });
        for (const f of files) {
            if (f.startsWith("Origo BC MCP") && (f.endsWith(".lnk") || f.endsWith(".command") || f.endsWith(".desktop"))) {
                entries.push(join(desktop, f));
            }
        }
    }
    catch { /* non-fatal */ }
    return entries;
}
export function createDesktopShortcut(connectionName) {
    const desktop = getDesktopPath();
    if (!existsSync(desktop)) {
        throw new Error(`Desktop folder not found: ${desktop}`);
    }
    const label = connectionName ? `Origo BC MCP (${connectionName})` : "Origo BC MCP Server";
    if (platform() === "win32") {
        createWindowsShortcut(desktop, label, connectionName);
    }
    else if (platform() === "darwin") {
        createMacShortcut(desktop, label, connectionName);
    }
    else {
        createLinuxDesktopEntry(desktop, label, connectionName);
    }
}
function createWindowsShortcut(desktop, label, _connectionName) {
    const lnkPath = join(desktop, `${label}.lnk`);
    // We point to cmd.exe so the console stays open on error.
    const script = `
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')
    $sc.TargetPath = 'cmd.exe'
    $sc.Arguments = '/k origo-bc-mcp-server'
    $sc.WorkingDirectory = '%USERPROFILE%'
    $sc.Description = '${label}'
    $sc.Save()
  `.trim();
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
    });
    if (res.status !== 0) {
        throw new Error((res.stderr ?? "").trim() || `PowerShell exited with ${res.status}`);
    }
    console.log(`  Shortcut: ${lnkPath}`);
}
function createMacShortcut(desktop, label, _connectionName) {
    // Create a .command file (double-clickable shell script).
    const cmdPath = join(desktop, `${label}.command`);
    const script = [
        "#!/bin/bash",
        `# ${label} — starts the Origo BC MCP server`,
        `cd "$HOME"`,
        `exec origo-bc-mcp-server`,
        "",
    ].join("\n");
    writeFileSync(cmdPath, script, { mode: 0o755 });
    console.log(`  Shortcut: ${cmdPath}`);
}
function createLinuxDesktopEntry(desktop, label, connectionName) {
    const entryPath = join(desktop, `origo-bc-mcp${connectionName ? `-${connectionName}` : ""}.desktop`);
    const content = [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${label}`,
        `Exec=origo-bc-mcp-server`,
        "Terminal=true",
        `Comment=Start the Origo BC MCP server${connectionName ? ` (${connectionName})` : ""}`,
        "",
    ].join("\n");
    writeFileSync(entryPath, content, { mode: 0o755 });
    console.log(`  Shortcut: ${entryPath}`);
}
// ── Main wizard ──────────────────────────────────────────────────────────────
export async function runSetup() {
    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║   origo-bc-mcp-server — Connection Setup       ║");
    console.log("╚══════════════════════════════════════════╝\n");
    const localPath = getLocalSettingsPath();
    const mcpPath = getVSCodeMcpPath();
    console.log(`Local settings: ${localPath}`);
    console.log(`VS Code MCP:    ${mcpPath}\n`);
    // Step 1: Connection name
    const connName = await ask("Connection name (used in mcp.json server entry)", "default");
    const isDefault = connName === "default";
    // Step 2: Connection type
    const connType = await askChoice("Connection type:", ["SaaS (Entra ID)", "On-prem (Basic auth)"], 0);
    const isSaaS = connType.startsWith("SaaS");
    let connection;
    if (isSaaS) {
        const tenantId = await ask("Entra tenant ID (GUID)");
        const clientId = await ask("App registration client ID (GUID)");
        const authFlow = await askChoice("Authentication flow:", [
            "Client secret",
            "Device code (refresh token)",
            "Environment variable (env:VAR_NAME)",
        ], 0);
        let clientSecret;
        let refreshToken;
        if (authFlow.startsWith("Client secret")) {
            clientSecret = await askSecretStorage("client secret", "BC_DEV_CLIENT_SECRET", `origo-bc-mcp-${connName}-secret`);
        }
        else if (authFlow.startsWith("Device code")) {
            console.log("\n  Starting device code authentication...");
            const rawToken = await deviceCodeFlow(tenantId, clientId);
            refreshToken = await wrapKnownSecret("refresh token", rawToken, "BC_DEV_REFRESH_TOKEN", `origo-bc-mcp-${connName}-token`);
        }
        else {
            // env:VAR_NAME for client secret
            const envVar = await ask("Environment variable name for client secret", "BC_DEV_CLIENT_SECRET");
            clientSecret = `env:${envVar}`;
        }
        const environment = await ask("BC environment name", "production");
        const companyId = await ask("Company ID (GUID, optional)");
        connection = { tenantId, clientId, environment };
        if (clientSecret)
            connection.clientSecret = clientSecret;
        if (refreshToken)
            connection.refreshToken = refreshToken;
        if (companyId)
            connection.companyId = companyId;
    }
    else {
        // On-prem
        const baseUrl = await ask("BC base URL (e.g. https://host:443/BC/rest)");
        const onPremTenant = await ask("On-prem tenant", "default");
        const user = await ask("Web service user");
        const key = await askSecretStorage("web service key", "BC_DEV_WS_KEY", `origo-bc-mcp-${connName}-wskey`);
        const environment = await ask("Environment label", "onprem");
        const companyId = await ask("Company ID (GUID, optional)");
        const companyName = await ask("Company name (optional)");
        connection = { onPrem: true, baseUrl, onPremTenant, user, key, environment };
        if (companyId)
            connection.companyId = companyId;
        if (companyName)
            connection.companyName = companyName;
    }
    // Step 2b: Validate the connection
    const validationResult = await validateAndUpdate(connection, connName);
    if (validationResult?.newRefreshToken) {
        connection.refreshToken = validationResult.newRefreshToken;
    }
    // Step 3: Basic auth settings (for the local dev server)
    const settings = readLocalSettings(localPath);
    if (settings.basicAuth) {
        console.log(`\n  Existing Basic auth: username="${settings.basicAuth.username}"`);
        const updateAuth = await askChoice("Update Basic auth credentials?", ["Keep existing", "Update"], 0);
        if (updateAuth === "Update") {
            const username = await ask("Basic auth username", settings.basicAuth.username);
            const password = await ask("Basic auth password");
            settings.basicAuth = { enabled: true, username, password };
        }
    }
    else {
        const username = await ask("Basic auth username (for local dev server)", "dev");
        const password = await ask("Basic auth password", "change-me");
        settings.basicAuth = { enabled: true, username, password };
    }
    // Step 4: Write connection to local settings
    if (isDefault) {
        settings.devConnection = connection;
    }
    else {
        if (!settings.connections)
            settings.connections = {};
        settings.connections[connName] = connection;
    }
    writeJson(localPath, settings);
    console.log(`\n✓ Local settings written: ${localPath}`);
    // Step 4b: Select setup connection (for default memory, UBL templates)
    {
        // Build list of all SaaS connections available.
        const saasChoices = [];
        if (settings.devConnection && !settings.devConnection.onPrem)
            saasChoices.push("default");
        if (settings.connections) {
            for (const [name, conn] of Object.entries(settings.connections)) {
                if (!name.startsWith("_") && !conn.onPrem)
                    saasChoices.push(name);
            }
        }
        if (saasChoices.length > 0) {
            const currentSetup = settings.setupConnection;
            const choices = [
                ...saasChoices.map((n) => n === currentSetup ? `${n} (current)` : n),
                "None (skip for now)",
            ];
            const defaultIdx = currentSetup ? choices.findIndex((c) => c.startsWith(currentSetup)) : 0;
            const picked = await askChoice("Which connection should be the setup environment? (default memory, UBL templates)", choices, defaultIdx >= 0 ? defaultIdx : 0);
            if (!picked.startsWith("None")) {
                const setupName = picked.replace(" (current)", "");
                settings.setupConnection = setupName;
                writeJson(localPath, settings);
                if (setupName !== currentSetup) {
                    console.log(`  ✓ Setup connection set to "${setupName}".`);
                }
            }
            else if (currentSetup) {
                // User chose "None" but there was a previous value — clear it.
                delete settings.setupConnection;
                writeJson(localPath, settings);
                console.log("  ✓ Setup connection cleared.");
            }
        }
    }
    // Step 5: Update VS Code mcp.json
    const updateMcp = await askChoice("Add/update VS Code MCP config?", ["Yes", "No"], 0);
    if (updateMcp === "Yes") {
        const serverUrl = await ask("Server URL", "http://localhost:3000/mcp");
        const serverName = connName === "default"
            ? "origo-bc-local"
            : `origo-bc-${connName}`;
        // Build URL with connection param for non-default connections
        const url = isDefault ? serverUrl : `${serverUrl}?connection=${connName}`;
        // Build auth header
        const ba = settings.basicAuth;
        const headers = {};
        if (ba?.enabled) {
            headers["Authorization"] = `Basic ${Buffer.from(`${ba.username}:${ba.password}`).toString("base64")}`;
        }
        const mcpConfig = readMcpConfig(mcpPath);
        if (!mcpConfig.servers)
            mcpConfig.servers = {};
        mcpConfig.servers[serverName] = { type: "http", url, ...(Object.keys(headers).length > 0 && { headers }) };
        writeJson(mcpPath, mcpConfig);
        console.log(`✓ MCP config updated: ${mcpPath}`);
        console.log(`  Server entry: "${serverName}" → ${url}`);
    }
    // Step 6: Offer desktop shortcut
    const createShortcut = await askChoice("Create a desktop shortcut to start the server?", ["Yes", "No"], 0);
    if (createShortcut === "Yes") {
        try {
            createDesktopShortcut(connName === "default" ? undefined : connName);
            console.log("✓ Desktop shortcut created.");
        }
        catch (e) {
            console.log(`  ⚠ Could not create shortcut: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    console.log("\n─── Setup complete ───");
    console.log("Start the server with: origo-bc-mcp-server");
    if (!isDefault) {
        console.log(`The "${connName}" connection is selected via ?connection=${connName} in the URL.`);
    }
    console.log("");
    rl.close();
}
// ── Focused "add" command ────────────────────────────────────────────────────
/**
 * Streamlined command to add a single connection.
 * Skips basic auth, desktop shortcut, and setup connection selection.
 */
export async function runAdd(name) {
    console.log("\n── Add Connection ──\n");
    const localPath = getLocalSettingsPath();
    const mcpPath = getVSCodeMcpPath();
    const settings = readLocalSettings(localPath);
    // Connection name (required)
    const connName = name || await ask("Connection name", "default");
    const isDefault = connName === "default";
    // Check for existing connection
    if (isDefault && settings.devConnection) {
        console.log(`  ⚠ Connection "default" already exists. This will overwrite it.`);
    }
    else if (!isDefault && settings.connections?.[connName]) {
        console.log(`  ⚠ Connection "${connName}" already exists. This will overwrite it.`);
    }
    // Connection type
    const connType = await askChoice("Connection type:", ["SaaS (Entra ID)", "On-prem (Basic auth)"], 0);
    const isSaaS = connType.startsWith("SaaS");
    let connection;
    if (isSaaS) {
        const tenantId = await ask("Entra tenant ID (GUID)");
        const clientId = await ask("App registration client ID (GUID)");
        const authFlow = await askChoice("Authentication flow:", [
            "Client secret",
            "Device code (refresh token)",
            "Environment variable (env:VAR_NAME)",
        ], 0);
        let clientSecret;
        let refreshToken;
        if (authFlow.startsWith("Client secret")) {
            clientSecret = await askSecretStorage("client secret", "BC_DEV_CLIENT_SECRET", `origo-bc-mcp-${connName}-secret`);
        }
        else if (authFlow.startsWith("Device code")) {
            console.log("\n  Starting device code authentication...");
            const rawToken = await deviceCodeFlow(tenantId, clientId);
            refreshToken = await wrapKnownSecret("refresh token", rawToken, "BC_DEV_REFRESH_TOKEN", `origo-bc-mcp-${connName}-token`);
        }
        else {
            const envVar = await ask("Environment variable name for client secret", "BC_DEV_CLIENT_SECRET");
            clientSecret = `env:${envVar}`;
        }
        const environment = await ask("BC environment name", "production");
        const companyId = await ask("Company ID (GUID, optional)");
        connection = { tenantId, clientId, environment };
        if (clientSecret)
            connection.clientSecret = clientSecret;
        if (refreshToken)
            connection.refreshToken = refreshToken;
        if (companyId)
            connection.companyId = companyId;
    }
    else {
        const baseUrl = await ask("BC base URL (e.g. https://host:443/BC/rest)");
        const onPremTenant = await ask("On-prem tenant", "default");
        const user = await ask("Web service user");
        const key = await askSecretStorage("web service key", "BC_DEV_WS_KEY", `origo-bc-mcp-${connName}-wskey`);
        const environment = await ask("Environment label", "onprem");
        const companyId = await ask("Company ID (GUID, optional)");
        const companyName = await ask("Company name (optional)");
        connection = { onPrem: true, baseUrl, onPremTenant, user, key, environment };
        if (companyId)
            connection.companyId = companyId;
        if (companyName)
            connection.companyName = companyName;
    }
    // Validate
    await validateAndUpdate(connection, connName);
    // Save to local settings
    if (isDefault) {
        settings.devConnection = connection;
    }
    else {
        if (!settings.connections)
            settings.connections = {};
        settings.connections[connName] = connection;
    }
    writeJson(localPath, settings);
    console.log(`\n✓ Connection "${connName}" saved to ${localPath}`);
    // Update VS Code mcp.json
    const serverUrl = "http://localhost:3000/mcp";
    const serverName = isDefault ? "origo-bc-local" : `origo-bc-${connName}`;
    const url = isDefault ? serverUrl : `${serverUrl}?connection=${connName}`;
    const ba = settings.basicAuth;
    const headers = {};
    if (ba?.enabled) {
        headers["Authorization"] = `Basic ${Buffer.from(`${ba.username}:${ba.password}`).toString("base64")}`;
    }
    const mcpConfig = readMcpConfig(mcpPath);
    if (!mcpConfig.servers)
        mcpConfig.servers = {};
    mcpConfig.servers[serverName] = { type: "http", url, ...(Object.keys(headers).length > 0 && { headers }) };
    writeJson(mcpPath, mcpConfig);
    console.log(`✓ MCP entry "${serverName}" → ${url}`);
    if (!isDefault) {
        console.log(`\n  Select with: ?connection=${connName}`);
    }
    console.log("");
    rl.close();
}
//# sourceMappingURL=setup.js.map