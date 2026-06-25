# BC MCP Server — Setup from Downloaded Tarball

Use this guide when you download the `origo-bc-mcp-server` package artifact as a tar file from Azure DevOps/Azure Artifacts instead of installing directly from the npm feed.

The downloaded file is expected to be an npm package tarball, usually named like:

```text
origo-bc-mcp-server-0.1.123.tgz
```

The same file works on macOS and Windows.

## Prerequisites

- **Node.js 22+** from [nodejs.org](https://nodejs.org)
- The downloaded `origo-bc-mcp-server-*.tgz` or `origo-bc-mcp-server-*.tar.gz` artifact

No npm feed authentication is needed when installing from the downloaded tarball.

## 1. Find the Downloaded File

### macOS

Open Terminal and go to the folder where the artifact was downloaded:

```bash
cd ~/Downloads
ls origo-bc-mcp-server-*.tgz
```

If the file has a `.tar.gz` extension, use that name in the commands below instead of `.tgz`.

### Windows

Open PowerShell and go to the folder where the artifact was downloaded:

```powershell
cd $env:USERPROFILE\Downloads
Get-ChildItem origo-bc-mcp-server-*.tgz
```

If the file has a `.tar.gz` extension, use that name in the commands below instead of `.tgz`.

## 2. Install the Server Globally

Install directly from the tarball. Do not extract it first.

### macOS

```bash
npm install -g ./origo-bc-mcp-server-*.tgz
```

### Windows

```powershell
npm install -g .\origo-bc-mcp-server-*.tgz
```

If PowerShell does not expand the wildcard for your npm version, install the exact file name:

```powershell
npm install -g .\origo-bc-mcp-server-0.1.123.tgz
```

Verify the command is available:

### macOS

```bash
origo-bc-mcp-server --help
```

### Windows

```powershell
origo-bc-mcp-server --help
```

## 3. Create Local Configuration

Run the init command once:

### macOS

```bash
origo-bc-mcp-server init
open ~/.origo-bc-mcp/local.settings.json
```

### Windows

```powershell
origo-bc-mcp-server init
notepad $env:USERPROFILE\.origo-bc-mcp\local.settings.json
```

The file contains examples for on-prem and SaaS Business Central connections. Keep `basicAuth.enabled` set to `true` for local MCP client access.

### On-prem Example

```json
{
  "basicAuth": {
    "enabled": true,
    "username": "dev",
    "password": "change-me"
  },
  "devConnection": {
    "onPrem": true,
    "baseUrl": "https://your-bc-host:443/instancerest",
    "onPremTenant": "default",
    "user": "your.username",
    "key": "your-web-service-key",
    "companyId": "COMPANY-GUID-HERE",
    "companyName": "My Company",
    "environment": "onprem"
  }
}
```

### SaaS Example

```json
{
  "basicAuth": {
    "enabled": true,
    "username": "dev",
    "password": "change-me"
  },
  "devConnection": {
    "tenantId": "your-entra-tenant-guid",
    "clientId": "your-app-client-id",
    "clientSecret": "your-client-secret",
    "environment": "production",
    "companyId": "COMPANY-GUID-HERE"
  }
}
```

## 4. Start the Server

### macOS

```bash
origo-bc-mcp-server
```

To use another port:

```bash
PORT=3001 origo-bc-mcp-server
```

### Windows

```powershell
origo-bc-mcp-server
```

To use another port:

```powershell
$env:PORT = "3001"
origo-bc-mcp-server
```

Expected startup output:

```text
origo-bc-mcp listening on :3000 (development)
  MCP endpoint:    http://localhost:3000/mcp
  Health:          http://localhost:3000/healthz
```

## 5. Verify Connectivity

Open a second terminal.

### macOS

```bash
curl http://localhost:3000/healthz
```

Expected response:

```json
{"status":"ok","service":"origo-bc-mcp","env":"development"}
```

### Windows

```powershell
Invoke-RestMethod http://localhost:3000/healthz
```

Expected output:

```text
status service      env
------ -------      ---
ok     origo-bc-mcp development
```

## 6. Configure an MCP Client

For VS Code Copilot or another MCP client, add this server configuration:

```json
{
  "servers": {
    "bc-mcp": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Basic <base64-encoded username:password>"
      }
    }
  }
}
```

The username and password are the `basicAuth.username` and `basicAuth.password` values from `local.settings.json`.

Generate the Basic auth value:

### macOS

```bash
echo -n 'dev:change-me' | base64
```

### Windows

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("dev:change-me"))
```

Then set the header to:

```text
Authorization: Basic <generated-value>
```

## Updating to a New Tarball

Download the new artifact and install it over the existing global package.

### macOS

```bash
cd ~/Downloads
npm install -g ./origo-bc-mcp-server-*.tgz
```

### Windows

```powershell
cd $env:USERPROFILE\Downloads
npm install -g .\origo-bc-mcp-server-*.tgz
```

Your `~/.origo-bc-mcp/local.settings.json` or `%USERPROFILE%\.origo-bc-mcp\local.settings.json` file is not overwritten by the package update.

## Uninstalling

### macOS

```bash
npm uninstall -g origo-bc-mcp-server
```

### Windows

```powershell
npm uninstall -g origo-bc-mcp-server
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found: origo-bc-mcp-server` or `'origo-bc-mcp-server' is not recognized` | Restart the terminal and check that the npm global bin folder is in `PATH`. |
| `ENOENT` or file not found during install | Run the install command from the folder that contains the downloaded `.tgz` file, or use the full path to the file. |
| `Unsupported engine` | Install Node.js 22 or newer. |
| `Template not found. Reinstall the package.` | Reinstall from the downloaded tarball. The package must include `config/local.settings.example.json`. |
| `ECONNREFUSED` when calling BC | Verify `devConnection.baseUrl`, tenant, environment, and company settings in `local.settings.json`. |
| `Authentication_InvalidCredentials` | Check the BC user/key for on-prem, or client credentials for SaaS. |
| Port 3000 in use | Start with `PORT=3001 origo-bc-mcp-server` on macOS or `$env:PORT = "3001"; origo-bc-mcp-server` on Windows. |
| SSL certificate errors against on-prem BC | For local testing only, set `NODE_TLS_REJECT_UNAUTHORIZED=0` before starting the server. |

## Custom Configuration Path

If you prefer a different config file location, pass it explicitly.

### macOS

```bash
origo-bc-mcp-server --config /path/to/local.settings.json
```

Or use an environment variable:

```bash
export MCP_LOCAL_SETTINGS_PATH=/path/to/local.settings.json
origo-bc-mcp-server
```

### Windows

```powershell
origo-bc-mcp-server --config C:\path\to\local.settings.json
```

Or use an environment variable:

```powershell
$env:MCP_LOCAL_SETTINGS_PATH = "C:\path\to\local.settings.json"
origo-bc-mcp-server
```
