# origo-bc-mcp

Origo Business Central MCP server — a local [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) MCP server that connects AI assistants (VS Code Copilot, Claude Desktop, Cowork) to Business Central.

> **This repository is managed by the Azure Pipelines CI build.**
> Do not commit here manually — content is replaced on every successful `main` build.

## Features

- **72 MCP tools** — records, search, metadata, queue, aging, translations, UBL, and more
- **Dual authentication** — OAuth 2.1 (production) + Basic auth (local dev)
- **Multi-connection** — configure multiple BC environments, select per-request via `?connection=<name>`
- **Secure secrets** — supports `env:`, `dpapi:` (Windows), `keychain:` (macOS) prefixes
- **Connection validation** — verify credentials reach BC before saving config
- **Device-code re-auth** — expired refresh tokens are renewed interactively during verify
- **Desktop shortcut** — optional shortcut to start the server with one click

## Requirements

- **Node.js 22+**
- A Business Central environment (SaaS or on-prem) with web service access

## Install

```bash
npm install -g github:businesscentralal/origo-bc-mcp
```

## Quick Start

```bash
# 1. Interactive setup — configures connection + VS Code mcp.json
origo-bc-mcp-server setup

# 2. Start the server
origo-bc-mcp-server
```

The setup wizard walks you through:
1. Connection type (SaaS / on-prem)
2. Credentials (client secret, device-code flow, or web service key)
3. Secret storage method (env var, DPAPI, Keychain, or plaintext)
4. **Validation** — acquires a token and calls BC to confirm it works
5. VS Code `mcp.json` entry (auto-configured)
6. **Desktop shortcut** (optional) — creates a clickable shortcut to start the server

## Commands

| Command | Description |
|---------|-------------|
| `origo-bc-mcp-server` | Start the MCP server |
| `origo-bc-mcp-server setup` | Guided connection + config wizard |
| `origo-bc-mcp-server verify` | Validate all configured connections |
| `origo-bc-mcp-server verify <name>` | Validate a specific named connection |
| `origo-bc-mcp-server init` | Create config from template (non-interactive) |
| `origo-bc-mcp-server --config <path>` | Start with a specific settings file |

## Verifying Connections

Run `verify` at any time to check that your credentials still work:

```bash
# Verify all connections
origo-bc-mcp-server verify

# Verify a specific one
origo-bc-mcp-server verify production
```

**What it does:**
- Resolves secret references (`env:`, `dpapi:`, `keychain:`)
- Acquires an access token (client_credentials or refresh_token grant)
- Calls BC `/api/v2.0/companies` to prove the token works
- Reports the number of accessible companies

**Refresh token renewal:**
If a refresh token is expired or revoked, `verify` automatically triggers a device-code flow — you authenticate in the browser and get a fresh token. The new token is saved back to `local.settings.json`.

## Multi-Connection Setup

Configure multiple BC environments in `local.settings.json`:

```json
{
  "devConnection": { "..." : "default connection" },
  "connections": {
    "production": { "tenantId": "...", "clientId": "...", "clientSecret": "env:BC_PROD_SECRET", "environment": "production" },
    "sandbox":    { "tenantId": "...", "clientId": "...", "clientSecret": "env:BC_SANDBOX_SECRET", "environment": "sandbox" }
  }
}
```

Select a connection in your VS Code `mcp.json` URL:

```json
{
  "servers": {
    "origo-bc-production": { "type": "http", "url": "http://localhost:3000/mcp?connection=production" },
    "origo-bc-sandbox":    { "type": "http", "url": "http://localhost:3000/mcp?connection=sandbox" }
  }
}
```

## Desktop Shortcut

During `setup`, you're offered a desktop shortcut that starts the server with one double-click:

| Platform | What's created |
|----------|---------------|
| Windows | `.lnk` file → opens a console running `origo-bc-mcp-server` |
| macOS | `.command` file (chmod 755) → opens Terminal with the server |
| Linux | `.desktop` entry with `Terminal=true` |

## Security

- Secrets are **never** stored in plaintext by default — the wizard recommends env vars or platform-native encryption
- `dpapi:` blobs are bound to the current Windows user + machine (DPAPI CurrentUser scope)
- `keychain:` values are stored in the macOS login Keychain
- Basic auth is only active in `NODE_ENV=development` — ignored in production
- The server validates TLS certificates by default (set `NODE_TLS_REJECT_UNAUTHORIZED=0` only for on-prem self-signed certs)

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `local.settings.json` | `~/.origo-bc-mcp/` or `./config/` | BC connections + Basic auth |
| `mcp.json` | VS Code user settings | MCP server entries for Copilot |

## License

Proprietary — Origo hf.
