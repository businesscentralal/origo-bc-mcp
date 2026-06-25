# BC MCP Server — macOS Setup Guide

## Prerequisites

- **Node.js 22+** — Install from [nodejs.org](https://nodejs.org) or via Homebrew:
  ```bash
  brew install node@22
  ```
- **Azure DevOps access** — You need read access to the `BC-PTE-CloudEvents` Artifacts feed

---

## Step 1: Configure npm to use the Origo feed

Open Terminal and run:

```bash
npm config set registry https://pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/
```

Authenticate (one-time):

```bash
npx vsts-npm-auth -config ~/.npmrc
```

> **Note:** If `vsts-npm-auth` doesn't work on macOS, generate a Personal Access Token (PAT) in Azure DevOps with **Packaging (Read)** scope, then add to `~/.npmrc`:
>
> ```
> //pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/:username=anything
> //pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/:_password=<BASE64_PAT>
> //pkgs.dev.azure.com/origo-bc-pte/BC-PTE-CloudEvents/_packaging/BC-PTE-CloudEvents/npm/registry/:email=your@email.com
> ```
>
> To encode your PAT: `echo -n '<YOUR_PAT>' | base64`

---

## Step 2: Install the MCP server

```bash
npm install -g origo-bc-mcp-server
```

Verify installation:

```bash
origo-bc-mcp-server --help
```

---

## Step 3: Create your local configuration

```bash
origo-bc-mcp-server init
```

This creates `~/.origo-bc-mcp/local.settings.json` from the template.

Edit it with your BC connection details:

```bash
open ~/.origo-bc-mcp/local.settings.json
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

```bash
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

Open a new Terminal tab and run:

```bash
curl http://localhost:3000/healthz
```

Expected response:

```json
{"status":"ok","service":"origo-bc-mcp","env":"development"}
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

To generate the base64 auth value:

```bash
echo -n 'username:password' | base64
```

---

## Updating

```bash
npm update -g origo-bc-mcp-server
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found: origo-bc-mcp-server` | Check npm global bin is in PATH: `npm bin -g` |
| `ECONNREFUSED` when calling BC | Verify `baseUrl` in local.settings.json is reachable |
| `Authentication_InvalidCredentials` | Check `user` and `key` in devConnection |
| Port 3000 in use | Set `PORT=3001 origo-bc-mcp-server` |
| Config not found | Run `origo-bc-mcp-server init` or use `--config /path/to/file.json` |

---

## Custom config path

If you prefer a different config location:

```bash
origo-bc-mcp-server --config /path/to/my-settings.json
```

Or set the environment variable:

```bash
export MCP_LOCAL_SETTINGS_PATH=/path/to/my-settings.json
origo-bc-mcp-server
```

---

*Generated for origo-bc-mcp-server — Origo Business Central MCP Server*
