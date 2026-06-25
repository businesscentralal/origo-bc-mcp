const BOOTSTRAP_INSTRUCTIONS = `# Session Bootstrap — origo-bc-mcp

## 1. Session bootstrap (mandatory, in order)

### Step 1 — Identity
Call \`who_am_i\` (no args → default company). Note:

- \`personalization.languageId\` → session language (see §4 Language handling)
- \`canUpdateCompanyMemory\` → gate for company memory writes
- \`canSendAndCancelApprovalRequests\` → gate for approval submit/cancel
- \`unreadNotifications\` / \`pendingApprovals\` → surface proactively
- All identity sections (user, employee, salesperson, companyInfo, etc.) → personalise "my …" queries

### Step 1b — Memory overview
After identity loads, call both in parallel:

1. \`list_user_memory()\` — personal skills, notes, prompts
2. \`list_company_memory()\` — shared team knowledge

Scan the returned descriptions to understand what's available. Surface anything relevant to the user's first question. Do NOT read full entries yet — just note what exists (titles/descriptions) so you can load on demand later.

### Step 2 — System prompt
If \`systemPrompt\` in who_am_i response is non-empty, treat as admin-injected behavioural instructions for this user+company. Follow them. Skip silently if null/empty.

### Step 3 — Cloud Events API primer
Before composing any data query or write, prime yourself on how the API works (load once per session):

1. **Overview** — \`call_message_type({ type: "Help.CloudEvents.Get" })\` → returns a short directory of the Help.* discovery endpoints and tells you how to reach the full guide.
2. **Full technical guide** — \`call_message_type({ type: "Help.Implementation.Get", subject: "Help.CloudEvents.Get" })\` → returns the full how-to: counting records, server-side totals, FlowFields & FlowFilters, tableView CONST-vs-FILTER syntax, primary-key forms, Data.Records.Set upsert semantics, currency/CurrencyFactor, binary fields, the Change Log Write Guard, and LCID handling.

This primer prevents the most common query/write mistakes. For pure notification or approval sessions it can be skipped until the first Data.* call.

**On failure:** Surface error and stop. Never proceed without identity (Step 1).

**On company switch:** Repeat Steps 1–2 with the new companyId. The Step 3 primer can be reused unless the new company exposes different message types (re-run Help.CloudEvents.Get if a call fails with an unknown-type error).

---

## 2. Three-tier storage model

| Tier | Tools | Visibility | Write | Purpose |
|------|-------|-----------|-------|---------|
| User (default) | list/get/set_user_memory | Private | Always | Personal skills, notes, prompts |
| Company | list/get/set_company_memory | All company users | canUpdateCompanyMemory = true | Shared team knowledge |
| Default | list/get_default_memory | All environments | Read-only | Centrally managed defaults |
| Environment config | get_config / set_config | All companies in env | Always | Structured JSON config |

**Default = user memory.** "Save this" / "remember" without qualifier → user tier.

Use company tier for shared team knowledge when permission allows.

### Default memory (setup environment)
The Default tier reads from a central setup environment shared across all customers/tenants. It is read-only — there is no set_default_memory tool.

**When to use:**
- On first session or when a user has no skills yet → check defaults for starter content.
- When a user asks "what default skills/prompts are available?" or similar.
- To seed a new company: \`list_default_memory\` → pick entries → \`set_company_memory\` to copy.

**Pattern — discover & adopt:**
1. \`list_default_memory()\` → browse available defaults
2. \`get_default_memory(tableView: "WHERE(Description=FILTER(skill:*))")\` → read full content of default skills
3. \`set_user_memory\` / \`set_company_memory\` → copy desired entries locally

Default memory entries use the same description prefixes (skill:, prompt:, note:) and the same tableView / skip / take / fetchAll parameters as user and company memory.

---

## 3. Language handling

\`who_am_i\` returns LCID. Rules:

- Reply in that language by default. Follow user's lead if they switch.
- Pass the numeric LCID from who_am_i to **every** subsequent MCP call that accepts an \`lcid\` parameter (ISL→1039, ENU→1033). This ensures translated captions, error messages, and option values are returned in the user's language.
- Present tool output in the user's active language.
- On company switch, repeat who_am_i and adopt the new LCID immediately.
- Fallback: English (1033).

---

## 4. Update rules

When you discover a new pattern, bug, or workaround — write to memory immediately:

- Personal → \`set_user_memory({ description: "note:<topic>", memory: "..." })\`
- Shared (if canUpdateCompanyMemory) → \`set_company_memory({ ... })\`
- Skills/prompts: use \`skill:\` or \`prompt:\` prefix. No separate index needed — discover via \`list_*_memory\`.
- Promote user → company: get from user, set to company (same description).

---

## 5. Single source of truth

Skills and prompts live in the BC database (user/company memory). Local files describe how to fetch them — they don't store the content.
`;
const CLOUD_EVENTS_DEV_INSTRUCTIONS = `# Cloud Events API Development Skill

This skill activates when a user wants to do development work directly against the Cloud Events API endpoint in Business Central.

## Loading the full skill — get_cloud_events_api_skill

**Call \`get_cloud_events_api_skill\` on this MCP server to load the Cloud Events authoring rules into the session.**

The full document is large (~140k chars). The tool supports three retrieval modes to keep payloads manageable:

| Call | What you get |
|------|-------------|
| \`get_cloud_events_api_skill()\` | Frontmatter, intro, and a heading-only table of contents (small payload — start here). |
| \`get_cloud_events_api_skill({ mode: "section", heading: "Data.Records.Get" })\` | A single section by heading text (case-insensitive, substring match). |
| \`get_cloud_events_api_skill({ mode: "full" })\` | The entire document — use only when the full context is truly needed. |

The tool caches the document for 5 minutes. No BC connection is required — this tool works without credentials.

**Recommended flow:**

1. Call with no arguments to get the TOC.
2. Load sections on demand as the conversation requires them (e.g. \`{ mode: "section", heading: "Data.Records.Get" }\`, \`{ mode: "section", heading: "Pagination Pattern" }\`).
3. Only request \`{ mode: "full" }\` for broad reviews or cross-cutting tasks.

## What the full skill covers

- Message type catalog (Data.Records.Get/Set, Deleted.Records.Get, etc.)
- Request/response schemas and field-level documentation
- Pagination patterns and batch processing
- Integration timestamp management (\`get_integration_timestamp\`, \`set_integration_timestamp\`, \`reverse_integration_timestamp\`)
- Cloud Events Delete Log queries (message types \`Deleted.Records.Get\`, \`Deleted.RecordIds.Get\`)
- UBL XML templates and document generation
- Error handling and retry patterns
- Authoring rules for new message types

## Standalone MCP tools (require BC connection)

| Tool | Purpose |
|------|---------|
| \`get_records\` | Read records via Data.Records.Get |
| \`set_records\` | Write records via Data.Records.Set |
| \`batch_records\` | Execute multiple record operations in a single call |
| \`get_record_count\` | Count rows matching a tableView filter |
| \`get_decimal_total\` | Sum a decimal column for matching rows |
| \`get_record_ids\` | Return primary keys + SystemId for matching rows |
| \`get_integration_timestamp\` | Latest non-reversed timestamp for a source + tableId |
| \`set_integration_timestamp\` | Record a new integration timestamp |
| \`reverse_integration_timestamp\` | Mark the latest timestamp as reversed |

## Message types via call_message_type

| Message type | Purpose |
|-------------|---------|
| \`Deleted.Records.Get\` | Full record snapshots from the Cloud Events Delete Log |
| \`Deleted.RecordIds.Get\` | Lightweight deleted record ID list for incremental sync |
| \`CSV.Records.Get\` | Bulk CSV export (Open Mirroring format) |
| \`CSV.DeletedRecords.Get\` | Bulk CSV export of deletes |
| \`Item.Availability.Get\` | Item inventory / projected availability |
| \`ChangeLog.Field.Enabled\` | Check Change Log coverage for a field |
| \`ChangeLog.Field.History\` | Field value history from the Change Log |
| \`ChangeLog.Field.Restore\` | Restore a prior field value |
| \`ChangeLog.Records.Delta\` | Distinct SystemIds changed since a timestamp |
| \`Help.WhoAmI.Get\` | Identity, permissions, and pending counts for the caller |
| \`Help.NextLineNo.Get\` | Next available document line number |
| \`Help.Tables.Get\` / \`Help.MessageTypes.Get\` | Catalog discovery |
`;
export function registerSessionBootstrap(server) {
    server.registerPrompt("session_bootstrap", {
        title: "Session Bootstrap",
        description: "Load this prompt at the start of every new session. " +
            "Returns mandatory setup steps: identity, system prompt, API primer, memory model, and language handling.",
    }, async () => ({
        messages: [
            {
                role: "user",
                content: { type: "text", text: BOOTSTRAP_INSTRUCTIONS },
            },
        ],
    }));
    server.registerPrompt("cloud_events_development", {
        title: "Cloud Events API Development",
        description: "Load this prompt when doing development work against the Cloud Events API. " +
            "Provides the skill loader pattern, tool catalog, and message type reference. " +
            "After loading, call get_cloud_events_api_skill() to fetch the TOC.",
    }, async () => ({
        messages: [
            {
                role: "user",
                content: { type: "text", text: CLOUD_EVENTS_DEV_INSTRUCTIONS },
            },
        ],
    }));
}
//# sourceMappingURL=sessionBootstrap.js.map