# Resume prompt

Paste the block below into a new Cowork session (with the `Origo` folder
connected) to continue this project. Fill in the bracketed answers if you have
them; otherwise the assistant will ask.

---

```
Continue the "Origo BC MCP server" project (new mcp.dynamics.is).

First, read these for full context before doing anything:
- /Users/ori.gunnarge/Git/Origo/Cloud Events MCP/docs/PROJECT-STATUS.md   (status, decisions, what's left, open questions)
- /Users/ori.gunnarge/Git/Origo/Cloud Events MCP/README.md
- /Users/ori.gunnarge/Git/Origo/Cloud Events MCP/docs/devops-setup.md
- /Users/ori.gunnarge/Git/Origo/Cloud Events MCP/infra/README.md

Repos:
- New server (work here): /Users/ori.gunnarge/Git/Origo/Cloud Events MCP   (branch feat/new-mcp-server)
- Legacy server (port tools FROM here): /Users/ori.gunnarge/Git/Origo/Cloud Events Website  (MCP at api/mcp/)

Key constraints (do not violate):
- TypeScript, @modelcontextprotocol/sdk, Streamable HTTP, Express, Node 22.
- Two auth methods: OAuth 2.1/PKCE (Entra JWT -> OBO to BC) and x-origo-token
  (AES-256-GCM blob, MUST stay byte-compatible with the legacy server; same MCP_ENCRYPTION_KEY).
- No default user/data connection — missing auth must error. BC_* env is only the OBO app identity.
- Keep the setup environment (SETUP_* client-credentials SP) for default memory + UBL tools only.
- assertTenantAccess() must gate every tool; tenants come from the user's real
  home+guest memberships (ARM /tenants). x-origo-token is locked to its blob tenant.
- Tenant=GUID, environment=typed by user, company=picked from list and saved as GUID.
- Verify by building (npm run build) and, where possible, running. Ask me about each step.

What I want to do next: [ migrate the BC tools  |  finish the Azure DevOps deploy  |  set up the Entra app  ].

Answers to the open questions (if known):
- Existing AzureRM service connection name (Tenant B): [ ... ]
- That SP has Owner / RBAC Administrator on the Tenant B subscription: [ yes / no / unsure ]
- Entra app registration (client id, audience, permissions, secret location): [ ... ]
- Tenant B subscription id + tenant id: [ ... ]
- Which legacy tools to expose vs. keep hidden-but-callable: [ ... ]

Start by reading PROJECT-STATUS.md, summarize where we are, then proceed with the
chosen next step — asking me before each significant action.
```
