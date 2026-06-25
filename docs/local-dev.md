# Running the MCP server locally (dev)

How to start the Origo BC MCP server on your machine and talk to it using
**Basic auth** against a dev BC instance (on-prem or SaaS).

> Basic auth is **dev only**. It is hard-disabled whenever `NODE_ENV=production`,
> and its config lives in a gitignored file. Never use it for a deployed server.

---

## 1. Prerequisites

- **Node.js 22+** (`node --version`).
- Dependencies installed:

  ```bash
  cd "/Users/ori.gunnarge/Git/Origo/Cloud Events MCP"
  npm install
  ```

## 2. Configure `config/local.settings.json`

This file is gitignored. If it doesn't exist, copy the template:

```bash
cp config/local.settings.example.json config/local.settings.json
```

It has two parts: `basicAuth` (the credentials the MCP client must send) and
`devConnection` (how the server reaches BC). Use **one** of the two
`devConnection` shapes.

### On-prem (Basic auth to a BC REST base URL)

```json
{
  "basicAuth": { "enabled": true, "username": "dev-user", "password": "dev-pass" },
  "devConnection": {
    "onPrem": true,
    "baseUrl": "https://<host>:443/<instance>rest",
    "onPremTenant": "default",
    "user": "<bc-web-service-user>",
    "key": "<bc-web-service-access-key>",
    "companyId": "<company-guid>",
    "companyName": "OnPrem",
    "environment": "onprem"
  }
}
```

Maps from the legacy Azure Functions `local.settings.json`:
`BC_ONPREM_BASE_URL → baseUrl`, `BC_ONPREM_TENANT → onPremTenant`,
`BC_ONPREM_USER → user`, `BC_ONPREM_KEY → key`,
`BC_COMPANY_ID → companyId`, `BC_COMPANY_NAME → companyName`.

### SaaS (Entra)

```json
{
  "basicAuth": { "enabled": true, "username": "dev-user", "password": "dev-pass" },
  "devConnection": {
    "tenantId": "<entra-tenant-guid>",
    "clientId": "<app-client-id>",
    "clientSecret": "<client-secret>",
    "environment": "UAT",
    "companyId": "<company-guid>"
  }
}
```

(Use `refreshToken` instead of `clientSecret` if you have one.)

> `basicAuth.username/password` (client → MCP) are independent of the BC
> credentials, but for convenience you can set them to the same values.

## 3. Start the server

```bash
npm run dev      # tsx watch, auto-reload; NODE_ENV defaults to development
# or
npm run build && npm start
```

You should see:

```
origo-bc-mcp listening on :3000 (development)
[local-settings] Basic auth ENABLED from .../config/local.settings.json — dev only.
```

Health check (no auth): `curl localhost:3000/healthz`.

## 4. Call it with curl

```bash
# 1) initialize — capture the mcp-session-id from the response headers
curl -i -X POST localhost:3000/mcp \
  -u 'dev-user:dev-pass' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

SID=<mcp-session-id from above>

# 2) complete initialization (once)
curl -s -X POST localhost:3000/mcp -u 'dev-user:dev-pass' \
  -H "mcp-session-id: $SID" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3) list tools
curl -s -X POST localhost:3000/mcp -u 'dev-user:dev-pass' \
  -H "mcp-session-id: $SID" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4) call a tool
curl -s -X POST localhost:3000/mcp -u 'dev-user:dev-pass' \
  -H "mcp-session-id: $SID" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"who_am_i","arguments":{}}}'
```

`who_am_i` should report `method: "basic"` and your tenant/environment.
`bc_list_companies` returns the configured company.

## 5. Use from an MCP client (e.g. MCP Inspector)

- Transport: **Streamable HTTP**
- URL: `http://localhost:3000/mcp`
- Header: `Authorization: Basic <base64(username:password)>`

Generate the header value:

```bash
echo -n 'dev-user:dev-pass' | base64
```

## Notes & troubleshooting

- **401 Unauthorized** — Basic auth disabled (check `NODE_ENV` is not
  `production` and `basicAuth.enabled` is `true`), wrong credentials, or
  `config/local.settings.json` not found. The `WWW-Authenticate` header lists the
  accepted schemes.
- **Port** — override with `PORT=3001 npm run dev`.
- **Custom settings path** — `MCP_LOCAL_SETTINGS_PATH=/path/to/file.json`.
- **Available tools today** — `who_am_i` + the discovery tools. The ~40 BC data
  tools (and on-prem data calls) arrive with the tool migration.
- **Tenant lock** — a Basic-auth (and `x-origo-token`) connection is locked to
  its configured tenant; it cannot target another tenant.
