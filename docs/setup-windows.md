# BC MCP Server — Windows Setup Guide

## Prerequisites

- **Node.js 22+** — Install from [nodejs.org](https://nodejs.org) (LTS recommended)
  - During install, ensure "Add to PATH" is checked
- **Azure DevOps access** — You need read access to the `BC-PTE-CloudEvents` Artifacts feed

---

## Step 1: Configure npm to use the Origo feed

Open PowerShell or Command Prompt and run:

```powershell
npm config set registry https://pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/
```

Authenticate (one-time):

```powershell
npx vsts-npm-auth -config %USERPROFILE%\.npmrc
```

> **Note:** If prompted, sign in with your Origo / Azure DevOps account.
>
> Alternative: Generate a Personal Access Token (PAT) in Azure DevOps with **Packaging (Read)** scope, then add to `%USERPROFILE%\.npmrc`:
>
> ```
> //pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/:username=anything
> //pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/:_password=<BASE64_PAT>
> //pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/:email=your@email.com
> ```
>
> To encode your PAT in PowerShell:
> ```powershell
> [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("YOUR_PAT"))
> ```

---

## Step 2: Install the MCP server

```powershell
npm install -g origo-bc-mcp-server
```

Verify installation:

```powershell
origo-bc-mcp-server --help
```

---

## Step 3: Create your local configuration

```powershell
origo-bc-mcp-server init
```

This creates `%USERPROFILE%\.origo-bc-mcp\local.settings.json` from the template.

Edit it:

```powershell
notepad %USERPROFILE%\.origo-bc-mcp\local.settings.json
```

### On-prem example:

```json
{
  "basicAuth": {
    "enabled": true,
    "username": "your.username",
    "password": "your-password"
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

### SaaS example:

```json
{
  "basicAuth": {
    "enabled": true,
    "username": "dev",
    "password": "dev-password"
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

---

## Step 4: Start the server

```powershell
origo-bc-mcp-server
```

You should see:

```
origo-bc-mcp listening on :3000 (development)
  MCP endpoint:    http://localhost:3000/mcp
  Health:          http://localhost:3000/healthz
```

---

## Step 5: Verify connectivity

Open a new PowerShell window and run:

```powershell
Invoke-RestMethod http://localhost:3000/healthz
```

Expected output:

```
status  service      env
------  -------      ---
ok      origo-bc-mcp development
```

---

## Using with an MCP client (e.g. VS Code Copilot)

Add to your MCP client configuration:

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

To generate the base64 auth value in PowerShell:

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("username:password"))
```

---

## Updating

```powershell
npm update -g origo-bc-mcp-server
```

---

## Running as a background service (optional)

To keep the server running without a console window, you can use:

### Option A: PowerShell background job

```powershell
Start-Job -ScriptBlock { origo-bc-mcp-server }
```

### Option B: Windows Task Scheduler

1. Open Task Scheduler
2. Create Basic Task → Name: "BC MCP Server"
3. Trigger: At log on
4. Action: Start a program
   - Program: `node`
   - Arguments: find path with `npm root -g` then append `\origo-bc-mcp-server\dist\cli.js`
5. Check "Run whether user is logged on or not"

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `'origo-bc-mcp-server' is not recognized` | Restart terminal, or add npm global bin to PATH: `npm bin -g` |
| `ECONNREFUSED` when calling BC | Verify `baseUrl` in local.settings.json is reachable |
| `Authentication_InvalidCredentials` | Check `user` and `key` in devConnection |
| Port 3000 in use | Set env var: `$env:PORT=3001; origo-bc-mcp-server` |
| Config not found | Run `origo-bc-mcp-server init` or use `--config C:\path\to\file.json` |
| SSL certificate errors | For self-signed BC certs: `$env:NODE_TLS_REJECT_UNAUTHORIZED=0; origo-bc-mcp-server` |

---

## Custom config path

If you prefer a different config location:

```powershell
origo-bc-mcp-server --config C:\Users\you\my-settings.json
```

Or set the environment variable:

```powershell
$env:MCP_LOCAL_SETTINGS_PATH = "C:\Users\you\my-settings.json"
origo-bc-mcp-server
```

---

*Generated for origo-bc-mcp-server — Origo Business Central MCP Server*
