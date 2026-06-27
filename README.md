# origo-bc-mcp-server

Origo Business Central MCP server — connects AI clients (VS Code Copilot, Claude Desktop, etc.) to Business Central via the Cloud Events API.

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org) (LTS recommended)

## Install

```bash
npm install -g github:businesscentralal/origo-bc-mcp
```

Verify:

```bash
origo-bc-mcp-server --help
```

## Setup

Run the interactive setup wizard:

```bash
origo-bc-mcp-server setup
```

The wizard walks you through:
1. Connection type (SaaS or on-prem)
2. Credentials (client secret, refresh token, or web service key)
3. Secret storage (DPAPI on Windows, Keychain on macOS)
4. Connection validation
5. MCP client configuration (`mcp.json` for VS Code)
6. Desktop shortcut (optional)

Configuration is stored in `~/.origo-bc-mcp/local.settings.json` (macOS/Linux) or `%USERPROFILE%\.origo-bc-mcp\local.settings.json` (Windows).

## Managing connections

### Add a connection

Add a new connection without running the full setup wizard:

```bash
origo-bc-mcp-server add production
origo-bc-mcp-server add sandbox
origo-bc-mcp-server add           # prompts for name
```

This asks for connection details, validates, saves to `local.settings.json`, and registers the MCP entry in VS Code's `mcp.json`.

### List connections

```bash
origo-bc-mcp-server remove        # lists available connections without removing anything
```

### Remove a connection

```bash
origo-bc-mcp-server remove production
```

Removes the named connection from `local.settings.json` and its entry from VS Code's `mcp.json`. Prompts for confirmation.

### Create a desktop shortcut

```bash
origo-bc-mcp-server shortcut              # shortcut for default server
origo-bc-mcp-server shortcut production   # shortcut for a named connection
```

Creates a double-clickable shortcut on your Desktop to start the server:
- **Windows:** `.lnk` file (opens cmd)
- **macOS:** `.command` file (executable shell script)
- **Linux:** `.desktop` file

### Clean all config

```bash
origo-bc-mcp-server clean
```

Removes the entire `local.settings.json`, all `origo-bc-*` entries from VS Code's `mcp.json`, and all desktop shortcuts. Use this to start fresh. Prompts for confirmation.

## Start the server

```bash
origo-bc-mcp-server
```

Expected output:

```
origo-bc-mcp listening on :3000 (development)
  MCP endpoint:    http://localhost:3000/mcp
  Dashboard:       http://localhost:3000/dashboard
  Health:          http://localhost:3000/healthz
```

## Dashboard

The server includes a web dashboard at `/dashboard`:

- **Real-time logs** — SSE stream with filtering, auto-scroll, clear
- **Active sessions** — connected MCP clients
- **Server stats** — uptime, memory, PID, Node version
- **Debug toggle** — enable/disable `MCP_DEBUG` at runtime without restart
- **Setup UI** (`/dashboard/setup`) — manage connections, Basic Auth credentials, validate endpoints
- **Restart / Stop** — PM2-aware controls (in Docker containers)

The dashboard is protected by Basic Auth credentials. On first start with no config, it's open to allow initial setup.

## Custom port

```bash
PORT=3001 origo-bc-mcp-server          # macOS/Linux
$env:PORT="3001"; origo-bc-mcp-server   # Windows PowerShell
```

## Verify

Check server health:

```bash
curl http://localhost:3000/healthz
```

Validate BC connections:

```bash
origo-bc-mcp-server verify             # all connections
origo-bc-mcp-server verify production   # specific connection
```

## CLI reference

```
origo-bc-mcp-server [command] [options]

Commands:
  setup                 Guided wizard to configure connections and VS Code mcp.json
  add [name]            Add a single connection (streamlined)
  verify [name]         Validate a connection (default: all connections)
  remove <name>         Remove a specific connection (or list available)
  shortcut [name]       Create a desktop shortcut to start the server
  clean                 Remove ALL connections, config, and shortcuts
  init                  Create ~/.origo-bc-mcp/local.settings.json from template

Options:
  --config <path>       Start with a specific local.settings.json
  -h, --help            Show help
```

## Configure an MCP client

The `setup` wizard writes VS Code's `mcp.json` automatically. For other clients, add:

```json
{
  "servers": {
    "origo-bc-mcp": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Basic <base64-encoded username:password>"
      }
    }
  }
}
```

Generate the Basic auth value:

```bash
echo -n 'username:password' | base64                                          # macOS/Linux
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("username:password")) # Windows
```

The credentials are the `basicAuth.username` and `basicAuth.password` from your `local.settings.json`.

## Update

```bash
npm install -g github:businesscentralal/origo-bc-mcp
```

Your `local.settings.json` is preserved across updates.

## Uninstall

### Remove the npm package

```bash
npm uninstall -g origo-bc-mcp-server
```

### Remove configuration files

**Windows (PowerShell):**

```powershell
# Remove local settings
Remove-Item "$env:USERPROFILE\.origo-bc-mcp" -Recurse -Force -ErrorAction SilentlyContinue

# Remove MCP entries from VS Code (or use 'origo-bc-mcp-server clean' before uninstalling)
```

**macOS/Linux:**

```bash
rm -rf ~/.origo-bc-mcp
```

### Remove VS Code MCP entries

Either run `origo-bc-mcp-server clean` before uninstalling, or manually edit your VS Code `mcp.json`:

- **Windows:** `%APPDATA%\Code\User\mcp.json`
- **macOS:** `~/Library/Application Support/Code/User/mcp.json`
- **Linux:** `~/.config/Code/User/mcp.json`

Remove any `"origo-bc-*"` entries from the `"servers"` object.

### Remove desktop shortcut (if created)

Delete the "Origo BC MCP" shortcut from your Desktop manually.

### Remove stored secrets

If you used DPAPI or Keychain during setup, the encrypted values are embedded in the config files (already deleted above). Environment variables you set manually (e.g. `BC_DEV_CLIENT_SECRET`) should be removed separately:

```powershell
# Windows — remove a user-level env var
[Environment]::SetEnvironmentVariable('BC_DEV_CLIENT_SECRET', $null, 'User')
```

```bash
# macOS — remove Keychain entry
security delete-generic-password -a mcp-encrypted-conn -s origo-bc-mcp-default-secret
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found` / `not recognized` | Restart terminal; check npm global bin is in PATH: `npm bin -g` |
| `Unsupported engine` | Install Node.js 22+ |
| `ECONNREFUSED` when calling BC | Verify connection settings — run `origo-bc-mcp-server verify` |
| `Authentication_InvalidCredentials` | Check credentials — run `origo-bc-mcp-server verify` to re-auth |
| Port 3000 in use | Use a different port (see above) |
| SSL errors against on-prem BC | `NODE_TLS_REJECT_UNAUTHORIZED=0 origo-bc-mcp-server` (dev only) |

## Custom config path

```bash
origo-bc-mcp-server --config /path/to/local.settings.json
```

Or set `MCP_LOCAL_SETTINGS_PATH` environment variable.

## Develop

```bash
cp .env.example .env   # fill in BC_CLIENT_ID/SECRET, MCP_ENCRYPTION_KEY, ...
npm install
npm run dev            # tsx watch
# or
npm run build && npm start
```

Smoke check:

```bash
curl localhost:3000/healthz
curl localhost:3000/.well-known/oauth-protected-resource
```

### Basic auth

Basic auth secures MCP endpoints and the dashboard. It works in all environments
(local dev, Docker, production). Configure it in one of three ways:

1. **Dashboard Setup UI** — open `/dashboard/setup`, fill in credentials (recommended for Docker)
2. **Environment variables** — set `MCP_ADMIN_USER` + `MCP_ADMIN_PASSWORD` at startup
3. **Config file** — set `basicAuth` in `local.settings.json`:

```bash
cp config/local.settings.example.json config/local.settings.json
# edit: basicAuth.username/password + devConnection
npm run dev
```

Then call the server with Basic credentials:

```bash
curl -u admin:yourpass -X POST localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

The same credentials protect the web dashboard at `/dashboard`.

The Basic-auth connection is locked to its configured tenant (it cannot cross
tenants), exactly like `x-origo-token`.

`devConnection` supports two shapes:

- **On-prem** (`onPrem: true` + `baseUrl`, `onPremTenant`, `user`, `key`,
  `companyId`, `companyName`) — Basic auth against an on-prem BC REST base URL.
  Mirrors the legacy `BC_ONPREM_*` mode. `bc_list_companies` returns the
  configured company; data calls use `Basic base64(user:key)` against
  `{baseUrl}/api/origo/cloudevent/v1.0/...?tenant=...`.
- **SaaS** (`tenantId`, `clientId`, `clientSecret` or `refreshToken`) — Entra.

> On-prem **data** calls (message types) are wired during tool migration; the
> connection, auth header (`onPremAuthHeader`) and company listing are in place.

## Status & continuation

Scaffold + dual auth + tenant access guard + discovery tools are in place and
compile/run. Next: migrate the ~40+ BC tools from the legacy server (`api/mcp/tools/*`)
into `src/tools/`, then deploy to dev via Azure DevOps.

- **`docs/PROJECT-STATUS.md`** — full state, decisions, tool-migration inventory,
  open questions, resume checklist.
- **`docs/RESUME-PROMPT.md`** — ready-to-paste prompt to continue the work later.
- **`docs/local-dev.md`** — how to start the server locally (Basic auth, on-prem/SaaS).
- **`docs/devops-setup.md`** — cross-tenant deploy setup.

## Local install

### Run with Docker

The included `Dockerfile` builds a production image with PM2 for automatic restarts. Configuration is stored in a `/data` volume inside the container and managed through the web dashboard.

#### Step 1: Build the image

```bash
docker build -t origo-bc-mcp https://github.com/businesscentralal/origo-bc-mcp.git
```

#### Step 2: Run the container

Mount a local folder for persistent config storage:

```powershell
docker run -d --name origo-bc-mcp --restart unless-stopped -p 3000:3000 -v "E:\Docker Storage\origo-bc-mcp:/data" -e MCP_ENCRYPTION_KEY=<64-hex-chars> -e MCP_ADMIN_USER=admin -e MCP_ADMIN_PASSWORD=<your-password> -e OLLAMA_PROXY_TARGET=http://<ollama-host>:11434 origo-bc-mcp
```

```bash
docker run -d --name origo-bc-mcp --restart unless-stopped -p 3000:3000 -v /path/to/origo-bc-mcp-data:/data -e MCP_ENCRYPTION_KEY=<64-hex-chars> -e MCP_ADMIN_USER=admin -e MCP_ADMIN_PASSWORD=<your-password> -e OLLAMA_PROXY_TARGET=http://<ollama-host>:11434 origo-bc-mcp
```

> **`MCP_ENCRYPTION_KEY`** encrypts connection secrets (passwords, client secrets) at rest in the volume. Generate one with: `openssl rand -hex 32`
>
> **`MCP_ADMIN_USER` / `MCP_ADMIN_PASSWORD`** secure the dashboard on first boot. Without these, the dashboard is open until you configure Basic Auth in the setup UI.

#### Step 3: Configure via the dashboard

Open **http://localhost:3000/dashboard/setup** in your browser.

On first launch (no config exists), the dashboard is open. Add your first connection and enable Basic Auth — subsequent visits will require login.

The setup page lets you:
- Add SaaS (Entra) or On-Premises BC connections
- Validate connections (test button confirms access and lists companies)
- Configure Basic Auth credentials (used for both MCP access and dashboard login)
- Remove connections

#### Step 4: Connect your MCP client

Point your MCP client (VS Code Copilot, Claude Desktop, Open WebUI, etc.) at:

```
http://localhost:3000/mcp
```

With Basic Auth header using the credentials you configured in the dashboard.

#### Dashboard login

The dashboard is protected by the same Basic Auth credentials configured in Setup. If you haven't configured Basic Auth yet, the dashboard is open (to allow first-time setup).

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_DATA_DIR` | `/data` | Directory for `local.settings.json` (mounted volume) |
| `MCP_ADMIN_USER` | — | Bootstrap admin username (sets Basic Auth on first start if no config exists) |
| `MCP_ADMIN_PASSWORD` | — | Bootstrap admin password (pair with `MCP_ADMIN_USER`) |
| `MCP_ENCRYPTION_KEY` | — | 64 hex characters for AES-256-GCM encryption of secrets at rest |
| `MCP_PUBLIC_URL` | `http://localhost:3000` | Public URL for the server |
| `PORT` | `3000` | Listen port |
| `MCP_DEBUG` | — | Set to `1` to enable debug logging (also toggleable from dashboard) |
| `OLLAMA_PROXY_TARGET` | `http://192.168.16.241:11434` | Ollama server URL for the `/ollama` proxy endpoint |

#### Generating `MCP_ENCRYPTION_KEY`

The key must be exactly 64 hex characters (32 bytes). Generate one with any of these:

```bash
# OpenSSL (Linux/macOS/Git Bash)
openssl rand -hex 32

# Node.js (any platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# PowerShell (Windows)
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

Store the key securely — if you lose it, secrets encrypted with it cannot be recovered.

#### Docker Compose example

```yaml
services:
  mcp:
    build: https://github.com/businesscentralal/origo-bc-mcp.git
    ports:
      - "3000:3000"
    volumes:
      - ./mcp-data:/data
    environment:
      - MCP_ENCRYPTION_KEY=${MCP_ENCRYPTION_KEY}
      - MCP_ADMIN_USER=${MCP_ADMIN_USER:-admin}
      - MCP_ADMIN_PASSWORD=${MCP_ADMIN_PASSWORD}
    restart: unless-stopped
```

#### Health check

```bash
curl http://localhost:3000/healthz
```

### Install from tarball

The server is published to the Azure Artifacts feed `BC-PTE-CloudEvents` for
local dev/test on Windows and macOS. If you download the package artifact as a
tarball, use the cross-platform setup guide:

- **[Setup from downloaded tarball](docs/setup-from-tarball.md)**

The older feed-based guides are still available if you want npm to install
directly from Azure Artifacts:

- **[macOS feed setup guide](docs/setup-macos.md)**
- **[Windows feed setup guide](docs/setup-windows.md)**
