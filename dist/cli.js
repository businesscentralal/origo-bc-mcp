#!/usr/bin/env node
/**
 * CLI entry point for origo-bc-mcp-server.
 * Supports:
 *   origo-bc-mcp-server          — starts the server
 *   origo-bc-mcp-server init     — creates ~/.origo-bc-mcp/local.settings.json from template
 *   origo-bc-mcp-server --config — starts with a specific config path
 */
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CONFIG_DIR = join(homedir(), ".origo-bc-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "local.settings.json");
if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: origo-bc-mcp-server [command] [options]

Commands:
  setup                 Guided wizard to configure connections and VS Code mcp.json
  add [name]            Add a single connection (streamlined)
  verify [name]         Validate a connection (default: all connections)
  remove <name>         Remove a specific connection (or list available)
  clean                 Remove ALL connections and reset config
  init                  Create ~/.origo-bc-mcp/local.settings.json from the package template

Options:
  --config <path>       Start with a specific local.settings.json file
  -h, --help            Show this help

Examples:
  origo-bc-mcp-server setup
  origo-bc-mcp-server add production
  origo-bc-mcp-server verify
  origo-bc-mcp-server verify production
  origo-bc-mcp-server remove production
  origo-bc-mcp-server clean
  origo-bc-mcp-server init
  origo-bc-mcp-server
  origo-bc-mcp-server --config ./config/local.settings.json`);
    process.exit(0);
}
if (args[0] === "setup") {
    const { runSetup } = await import("./cli/setup.js");
    await runSetup();
    setTimeout(() => process.exit(0), 10);
}
if (args[0] === "add") {
    const { runAdd } = await import("./cli/setup.js");
    await runAdd(args[1]);
    setTimeout(() => process.exit(0), 10);
}
if (args[0] === "verify") {
    const { runVerify } = await import("./cli/verifyCommand.js");
    await runVerify(args[1]);
    process.exit(0);
}
if (args[0] === "remove") {
    const { runRemove } = await import("./cli/remove.js");
    await runRemove(args[1]);
    process.exit(0);
}
if (args[0] === "clean") {
    const { runClean } = await import("./cli/remove.js");
    await runClean();
    process.exit(0);
}
if (args[0] === "init") {
    if (existsSync(CONFIG_FILE)) {
        console.log(`Config already exists: ${CONFIG_FILE}`);
        console.log("Edit it with your BC connection details.");
    }
    else {
        mkdirSync(CONFIG_DIR, { recursive: true });
        // Resolve the example template relative to the package
        const templatePath = resolve(__dirname, "..", "config", "local.settings.example.json");
        if (!existsSync(templatePath)) {
            console.error("Template not found. Reinstall the package.");
            process.exit(1);
        }
        copyFileSync(templatePath, CONFIG_FILE);
        console.log(`Created: ${CONFIG_FILE}`);
        console.log("Edit the file with your BC connection details, then run: origo-bc-mcp-server");
    }
    process.exit(0);
}
// --config flag or auto-detect config location
const configIdx = args.indexOf("--config");
if (configIdx !== -1 && args[configIdx + 1]) {
    process.env.MCP_LOCAL_SETTINGS_PATH = resolve(args[configIdx + 1]);
}
else if (!process.env.MCP_LOCAL_SETTINGS_PATH) {
    // Auto-detect: CWD/config/local.settings.json → ~/.origo-bc-mcp/local.settings.json
    const cwdConfig = resolve(process.cwd(), "config", "local.settings.json");
    if (existsSync(cwdConfig)) {
        process.env.MCP_LOCAL_SETTINGS_PATH = cwdConfig;
    }
    else if (existsSync(CONFIG_FILE)) {
        process.env.MCP_LOCAL_SETTINGS_PATH = CONFIG_FILE;
    }
}
// Start the server
await import("./index.js");
//# sourceMappingURL=cli.js.map