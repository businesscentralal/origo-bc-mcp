# Project status & handoff — Origo BC MCP server

_Last updated: 2026-06-11._

This is the continuation document for the **new standalone Business Central MCP
server** (`mcp.dynamics.is`). It captures the goal, decisions, what is built,
what remains, and the open questions, so the work can resume cleanly later.

---

## Goal

Build a **new** Node.js MCP server (`mcp.dynamics.is`) **without touching** the
existing `dynamics.is/api/mcp`. It must serve:

- **claude.ai** via OAuth 2.1 + PKCE (Entra ID), and
- **OpenClaw** via an encrypted `x-origo-token` header.

Tech: Node.js 22, `@modelcontextprotocol/sdk`, Streamable HTTP transport,
Express. ~40+ BC tools migrated from the legacy server. Multi-tenant /
multi-environment / multi-company with a hard `assertTenantAccess()` guard.
Infra as Bicep in the same repo; deploy via **Azure DevOps** (not GitHub).

Repos on disk:
- Legacy server (source of tools): `/Users/ori.gunnarge/Git/Origo/Cloud Events Website` (Azure Functions; MCP at `api/mcp/`).
- New server (this repo): `/Users/ori.gunnarge/Git/Origo/Cloud Events MCP`.

---

## Decisions made

| Topic | Decision |
|---|---|
| Language | **TypeScript** (NodeNext ESM, strict). |
| OAuth model | **Entra ID as IdP + On-Behalf-Of (OBO)**. The server is a resource server: validates the Entra JWT, then OBO-exchanges into BC so the user's own BC permissions apply. No custom authorization server. |
| `x-origo-token` | **Reuses the legacy AES-256-GCM blob** byte-for-byte (`iv(12) ‖ tag(16) ‖ ciphertext`, base64). `MCP_ENCRYPTION_KEY` MUST match the legacy server. |
| Tenant selection | Tenant is **driven by the caller's real directory memberships** (home + guest), enumerated like `myaccount.microsoft.com` via an OBO token to ARM `GET /tenants`. Not a free per-call switch. |
| Environment selection | **User types it** (no enumeration). |
| Company selection | **List → user picks**; stored as a **GUID**. |
| Selection persistence | Hybrid: `bc_select` saves a session default; tools accept per-call overrides. |
| Default connection | **None.** Missing auth = error. `BC_*` env is only the OBO app identity. |
| Setup environment | **Kept** exactly as legacy: `SETUP_*` client-credentials SP for shared/default data (default memory + UBL templates). |
| Region | **North Europe**. |
| DNS | CNAME `mcp` + `asuid.mcp` TXT in zone `dynamics.is` (RG `origo-dns-rg`). |
| Deploy | Azure DevOps pipeline; **reuse an existing AzureRM service connection** to Tenant B (name still TBD — see open questions). |

---

## What is built (and verified)

- Full TypeScript scaffold; `npm run build` / `tsc` pass (exit 0); server boots,
  `/healthz` and `/.well-known/oauth-protected-resource` respond, unauthenticated
  `/mcp` returns 401 with the correct `WWW-Authenticate`.
- **Dual auth middleware** (`src/auth/middleware.ts`): Bearer (Entra JWT via
  `jose`, audience + issuer checks) and `x-origo-token` (AES-256-GCM decode).
- **`assertTenantAccess()`** (`src/auth/tenantAccess.ts`): home tenant always
  allowed; OAuth guests allowed only if the tenant is in their real ARM
  `/tenants` list; `x-origo-token` locked to its blob tenant.
- **OBO + ARM tenant listing** (`src/auth/entra.ts`).
- **Discovery tools** (`src/tools/discovery.ts`): `bc_list_tenants`,
  `bc_list_environments` (guidance only), `bc_list_companies`, `bc_select`,
  `bc_get_selection`; plus `who_am_i` (`src/tools/whoami.ts`).
- **BC client** (`src/bc/client.ts`): token acquisition (OBO / refresh /
  client-credentials) + `listCompanies`.
- **Setup connection** (`src/bc/setupConn.ts`): mirrors legacy `resolveSetupConn`.
- **Infra** (`infra/`): subscription-scoped `main.bicep` → `core` (LA, ACR,
  managed identity + role assignments, Key Vault RBAC, Container Apps env,
  Container App) + `dns` (in `origo-dns-rg`) + `certificate`. Two-phase pattern
  via `enableCustomDomainBinding` / `wireKeyVaultSecrets`. See `infra/README.md`.
- **Dev-only Basic auth** (`src/config/localSettings.ts` + middleware): enabled
  via gitignored `config/local.settings.json`, backed by a local dev BC
  connection, **hard-disabled when `NODE_ENV=production`**, tenant-locked like
  `x-origo-token`. Verified end-to-end (401 challenges, wrong/right creds, prod guard).
  Supports both **on-prem** (`onPrem`/`baseUrl`/`user`/`key` — Basic auth, mirrors
  legacy `BC_ONPREM_*`) and **SaaS** dev connections. `config/local.settings.json`
  is populated with the user's on-prem dev instance. On-prem **data** calls
  (message types) still need wiring during tool migration (use `onPremAuthHeader`
  + `{baseUrl}/api/origo/cloudevent/v1.0/...?tenant=...`; see legacy `shared/bcRuntime.js`).
- **Dockerfile** (Node 22 multi-stage).
- **Pipeline** (`azure-pipelines.yml`): Build → Deploy (provision infra →
  `az acr build` → deploy app from ACR). Binding/secrets behind parameters.
- **DevOps guide** (`docs/devops-setup.md`).

Git: branch **`feat/new-mcp-server`**. Commit `6878efd` has the scaffold/infra/
pipeline. **The setup-environment changes are saved on disk but NOT yet committed**
(a sandbox git-lock issue; see "Resume checklist").

---

## What remains

### Task 5 — Migrate the ~40+ BC tools (biggest piece)

Port from legacy `Cloud Events Website/api/mcp/tools/*.js` into `src/tools/*.ts`,
registering each via `server.registerTool(...)` with zod schemas, using
`getAuthContext()` + `assertTenantAccess()` + the BC client. Group by legacy file:

| Legacy file | Tools |
|---|---|
| `connection.js` | `list_companies`, `validate_connection` |
| `message-types.js` | `list_message_types`, `get_message_type_help` |
| `whoami.js` | `who_am_i` (done as a stub — extend to Help.WhoAmI.Get) |
| `table-metadata.js` | `list_tables`, `get_table_info` |
| `table-schema.js` | `get_table_fields`, `get_table_relations` |
| `data-records.js` | `get_records`, `set_records` |
| `search.js` | `search_customers/items/vendors/contacts/employees/gl_accounts/bank_accounts/resources/fixed_assets/projects/records` |
| `totals.js` | `get_record_count`, `get_decimal_total` |
| `utility-records.js` | `get_record_ids`, `get_table_permissions`, `get_page_url` |
| `integration-timestamps.js` | `get/set/reverse_integration_timestamp` |
| `period-breakdown.js` | `compute_period_breakdown` |
| `customer-aging.js` | `compute_customer_aging` |
| `vendor-aging.js` | `compute_vendor_aging` |
| `call-message-type.js` | `call_message_type`, `queue_message_type` |
| `queue.js` | `queue_get_status`, `queue_retry`, `queue_cancel` |
| `translations.js` | `list_translations`, `set_translations` |
| `memory-config.js` | `get/set/list_company_memory`, `get/set/list_user_memory`, `get/set_config`, **`get_default_memory`, `list_default_memory`** (← setup env) |
| `cloud-events-skill.js` | `get_cloud_events_api_skill` (no BC connection) |
| `incoming-documents-core.js` | `create_incoming_document`, `extract_incoming_document_attachments` |
| `incoming-documents-process.js` | `process_incoming_document` |
| `batch-records.js` | `batch_records` |
| `document-lines.js` | `get_document_lines` |
| `crypto-tools.js` | `encrypt_data`, `decode_base64`, `encode_base64` (decrypt restricted) |
| `ubl.js` | **`list_ubl_templates`, `render_ubl_template`** (← setup env) |
| `bc-event-subscriptions.js` | `list/create/renew/delete_bc_business_event_subscription`, `list_bc_business_event_definitions` |

Notes for migration:
- Legacy `tools/list` hides ~15 tools via a denylist but they remain callable —
  decide which to expose on the new server.
- `bc_list_companies` currently uses the standard BC API
  (`/v2.0/{tenant}/{env}/api/v2.0/companies`). The legacy server may use a Cloud
  Events endpoint — align endpoints during migration.
- The setup-backed tools (`*_default_memory`, UBL) must use `src/bc/setupConn.ts`,
  not the caller's connection.

### Task 7 — DevOps deploy (in progress)

1. Set the real service-connection name in `azure-pipelines.yml`
   (`azureServiceConnection`).
2. Confirm the SP has **Owner** or **RBAC Administrator** on the Tenant B
   subscription (Contributor can't create the role assignments in `core.bicep`).
3. Create DevOps environment `bcmcp-dev` and the pipeline from the YAML.
4. First run (params `false`) → push KV secrets (`MCP-ENCRYPTION-KEY` [match
   legacy!], `BC-CLIENT-SECRET`, `SETUP-CLIENT-SECRET`) → wait for managed cert
   `Succeeded` → re-run with `enableCustomDomainBinding=true wireKeyVaultSecrets=true`.

### Also pending

- **Entra app registration** for OAuth/OBO/ARM to work end-to-end: API
  permissions (BC `user_impersonation`, Azure Service Management
  `user_impersonation`), multi-tenant, an exposed audience matching
  `MCP_EXPECTED_AUDIENCES`, and a client secret in Key Vault.
- Bicep is **review-validated only** — run `az bicep build` / `what-if` locally
  (the sandbox can't fetch the Bicep CLI).
- Tests (`npm test` currently has none).

---

## Open questions

1. **Existing service connection name** to Tenant B (to put in the pipeline).
2. Does that connection's SP have rights to **create role assignments**?
3. Entra app registration details (client id/secret, audience, permissions).
4. Which legacy tools should be **exposed** vs. hidden-but-callable.

---

## Resume checklist

```bash
cd "/Users/ori.gunnarge/Git/Origo/Cloud Events MCP"

# 1) Finish the pending commit (sandbox left git locks; remove them on your Mac)
rm -f .git/HEAD.lock .git/index.lock
git add -A
git commit -m "Add setup-environment connection (SETUP_*) + infra wiring"
git push -u origin feat/new-mcp-server

# 2) Run locally
cp .env.example .env   # fill in values
npm install
npm run build && npm start
curl localhost:3000/healthz
```

See `docs/RESUME-PROMPT.md` for a ready-to-paste prompt to continue with an AI assistant.
