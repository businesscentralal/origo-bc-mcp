/**
 * Core BC runtime — sends Cloud Events to BC and follows data URLs.
 * Ported from the legacy server's shared/bcRuntime.js.
 */
import { config } from "../config.js";
import { getAuthContext } from "../auth/context.js";
import { getSelection } from "../session/store.js";
import { assertTenantAccess } from "../auth/tenantAccess.js";
import { getBcAccessToken, listCompanies, onPremAuthHeader } from "./client.js";
const BC_HOST = "api.businesscentral.dynamics.com";
const FETCH_ALL_BATCH_SIZE = 1000;
/** Hard cap on total records returned by fetchAllPages to prevent OOM on large tables. */
const FETCH_ALL_MAX_RECORDS = 10_000;
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
function dbg(...args) {
    if (config.debug)
        console.log("[BC]", ...args);
}
// ── Retry-capable fetch ─────────────────────────────────────────────────────
async function bcFetch(url, init, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(url, init);
        if (res.status === 429 || res.status === 503) {
            const retryAfter = Number(res.headers.get("Retry-After") || 2);
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            continue;
        }
        return res;
    }
    throw new Error(`BC fetch failed after ${retries} retries`);
}
// ── Company resolution ──────────────────────────────────────────────────────
const companiesCache = new Map();
/**
 * Resolves the target tenantId, environment, and company for a tool call.
 * Per-call overrides take precedence over the session selection.
 */
export async function resolveTarget(overrides) {
    const ctx = getAuthContext();
    const sel = getSelection(ctx.sessionId);
    const tenantId = await assertTenantAccess(overrides?.tenantId ?? sel.tenantId);
    const environment = overrides?.environment ?? sel.environment ?? ctx.conn.environment ?? config.defaultEnvironment;
    if (!environment) {
        throw new Error("No environment selected. Call bc_select first or pass environment.");
    }
    // Resolve company
    const companyOverride = overrides?.companyId ?? sel.companyId;
    if (ctx.conn.onPrem) {
        const id = companyOverride ?? ctx.conn.companyId;
        if (!id)
            throw new Error("On-prem mode: set BC_COMPANY_ID or pass companyId.");
        return {
            tenantId,
            environment,
            companyId: id,
            companyName: ctx.conn.companyName ?? id,
        };
    }
    const cacheKey = `${tenantId}|${environment}`;
    let companies = companiesCache.get(cacheKey);
    if (!companies) {
        companies = await listCompanies(tenantId, environment);
        companiesCache.set(cacheKey, companies);
    }
    if (!companies.length)
        throw new Error("No companies found in Business Central.");
    if (companyOverride) {
        const needle = companyOverride.toLowerCase();
        const found = companies.find((c) => c.id.toLowerCase() === needle || c.name.toLowerCase() === needle || c.displayName.toLowerCase() === needle);
        if (!found)
            throw new Error(`Company '${companyOverride}' not found. Use bc_list_companies to see available companies.`);
        return { tenantId, environment, companyId: found.id, companyName: found.displayName };
    }
    // Fall back to connection's companyId, then env vars, then first company
    const connId = ctx.conn.companyId;
    const envId = process.env.BC_COMPANY_ID;
    const envName = (process.env.BC_COMPANY_NAME ?? "").toLowerCase();
    let company;
    if (connId) {
        company = companies.find((c) => c.id.toLowerCase() === connId.toLowerCase());
    }
    else if (envId) {
        company = companies.find((c) => c.id.toLowerCase() === envId.toLowerCase());
    }
    else if (envName) {
        company = companies.find((c) => c.name.toLowerCase() === envName);
    }
    if (!company)
        company = companies[0];
    return { tenantId, environment, companyId: company.id, companyName: company.displayName };
}
export async function bcTask(tenantId, environment, companyId, envelope) {
    const ctx = getAuthContext();
    let auth;
    let taskUrl;
    if (ctx.conn.onPrem) {
        auth = onPremAuthHeader(ctx.conn);
        const base = ctx.conn.baseUrl.replace(/\/$/, "");
        const tenant = ctx.conn.onPremTenant ?? "default";
        taskUrl = `${base}/api/origo/cloudevent/v1.0/companies(${companyId})/tasks?tenant=${encodeURIComponent(tenant)}`;
    }
    else {
        const token = await getBcAccessToken(tenantId);
        auth = `Bearer ${token}`;
        taskUrl = `https://${BC_HOST}/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
    }
    dbg(`POST ${taskUrl}`);
    dbg(`  type=${envelope.type} subject=${envelope.subject || ""}`);
    const res = await bcFetch(taskUrl, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
    });
    const task = (await res.json());
    dbg(`  status=${task.status}${task.data ? " (has data URL)" : ""}`);
    if (task.status === "Error") {
        const errMsg = Array.isArray(task.error)
            ? JSON.stringify(task.error)
            : String(task.error || JSON.stringify(task));
        const err = new Error(errMsg);
        if (Array.isArray(task.error))
            err.bcErrors = task.error;
        throw err;
    }
    // If the task returns a data URL, follow it
    if (!task.data)
        return task;
    let dataStr = String(task.data);
    // BC may generate a malformed data URL when ?tenant= is in the task URL.
    // Pattern: .../responses?tenant=X(GUID)/data → .../responses(GUID)/data?tenant=X
    const malformedMatch = dataStr.match(/\/responses\?tenant=([^(]+)\(([0-9a-f-]+)\)\/data$/i);
    if (malformedMatch) {
        const [, tenant, guid] = malformedMatch;
        dataStr = dataStr.replace(`/responses?tenant=${tenant}(${guid})/data`, `/responses(${guid})/data?tenant=${tenant}`);
    }
    const isSaas = dataStr.startsWith(`https://${BC_HOST}/`);
    const isOnPrem = ctx.conn.onPrem &&
        (() => {
            try {
                return new URL(dataStr).hostname === new URL(ctx.conn.baseUrl).hostname;
            }
            catch {
                return false;
            }
        })();
    if (!isSaas && !isOnPrem)
        return task;
    const contentType = String(task.datacontenttype ?? "").toLowerCase();
    const isBinary = contentType.includes("pdf") || contentType.includes("octet-stream");
    const dataRes = await bcFetch(dataStr, {
        method: "GET",
        headers: { Authorization: auth },
    });
    if (isBinary) {
        const buf = Buffer.from(await dataRes.arrayBuffer());
        return { datacontenttype: task.datacontenttype, dataBase64: buf.toString("base64") };
    }
    const raw = await dataRes.text();
    const isText = contentType.includes("csv") || contentType.includes("plain") || contentType.includes("markdown");
    if (isText)
        return { result: raw };
    let result;
    try {
        result = JSON.parse(raw);
    }
    catch {
        return { result: raw };
    }
    if (result.status === "Error") {
        const errMsg = Array.isArray(result.error)
            ? JSON.stringify(result.error)
            : String(result.error || JSON.stringify(result));
        const err = new Error(errMsg);
        if (Array.isArray(result.error))
            err.bcErrors = result.error;
        throw err;
    }
    return result;
}
// ── bcQueuePost — POST to BC's /queues endpoint ─────────────────────────────
/**
 * Posts a Cloud Event to the BC /queues endpoint for async processing.
 * Returns the raw response (statusCode + parsed body).
 * Use this instead of bcTask for queue_message_type — BC has no Queue.Post
 * message type handler; the queue is a direct REST endpoint.
 */
export async function bcQueuePost(tenantId, environment, companyId, envelope) {
    const ctx = getAuthContext();
    let auth;
    let queueUrl;
    if (ctx.conn.onPrem) {
        auth = onPremAuthHeader(ctx.conn);
        const base = ctx.conn.baseUrl.replace(/\/$/, "");
        const tenant = ctx.conn.onPremTenant ?? "default";
        queueUrl = `${base}/api/origo/cloudevent/v1.0/companies(${companyId})/queues?tenant=${encodeURIComponent(tenant)}`;
    }
    else {
        const token = await getBcAccessToken(tenantId);
        auth = `Bearer ${token}`;
        queueUrl = `https://${BC_HOST}/v2.0/${tenantId}/${environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/queues`;
    }
    dbg(`POST ${queueUrl}`);
    dbg(`  type=${envelope.type} subject=${envelope.subject || ""}`);
    const res = await bcFetch(queueUrl, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
    });
    const text = await res.text();
    if (!text.trim())
        return { statusCode: res.status };
    try {
        return { statusCode: res.status, ...JSON.parse(text) };
    }
    catch {
        return { statusCode: res.status, _raw: text };
    }
}
// ── bcGet — simple GET ──────────────────────────────────────────────────────
export async function bcGet(tenantId, path) {
    const token = await getBcAccessToken(tenantId);
    const res = await bcFetch(`https://${BC_HOST}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok)
        throw new Error(`BC API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json());
}
// ── fetchAllPages — paginate through all results ────────────────────────────
export async function fetchAllPages(tenantId, environment, companyId, messageType, dataPayload, extraEnvelope = {}, batchSize = FETCH_ALL_BATCH_SIZE, maxRecords = FETCH_ALL_MAX_RECORDS) {
    let skip = 0;
    const allRecords = [];
    let noOfRecords;
    do {
        const effectiveBatch = Math.min(batchSize, maxRecords - allRecords.length);
        const result = await bcTask(tenantId, environment, companyId, {
            specversion: "1.0",
            type: messageType,
            source: MCP_SOURCE,
            data: JSON.stringify({ ...dataPayload, skip, take: effectiveBatch }),
            ...extraEnvelope,
        });
        const page = (result.result ?? result.value ?? (Array.isArray(result) ? result : []));
        if (noOfRecords === undefined && result.noOfRecords !== undefined) {
            noOfRecords = Number(result.noOfRecords);
        }
        allRecords.push(...page);
        skip += page.length;
        if (!page.length)
            break;
        if (allRecords.length >= maxRecords)
            break;
    } while (noOfRecords === undefined || allRecords.length < noOfRecords);
    const total = noOfRecords ?? allRecords.length;
    const truncated = allRecords.length < total ? true : undefined;
    return { records: allRecords, noOfRecords: total, fetched: allRecords.length, truncated };
}
// ── Helpers ─────────────────────────────────────────────────────────────────
const TABLE_NAME_RE = /^[a-zA-Z0-9 _\-./&()#\[\]"']+$/;
export function validateTableName(table) {
    if (!table || typeof table !== "string")
        throw new Error("Table name is required.");
    if (!TABLE_NAME_RE.test(table)) {
        throw new Error(`Invalid table name: '${table}'. Only alphanumeric, spaces, and common punctuation allowed.`);
    }
}
export function toMarkdownTable(headers, rows) {
    if (!headers.length)
        return "";
    const hdr = `| ${headers.join(" | ")} |`;
    const sep = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = rows
        .map((row) => `| ${row.map((c) => String(c ?? "")).join(" | ")} |`)
        .join("\n");
    return [hdr, sep, body].join("\n");
}
/** Extract result array from a bcTask response. */
export function extractRows(result) {
    if (Array.isArray(result.result))
        return result.result;
    if (Array.isArray(result.value))
        return result.value;
    if (Array.isArray(result))
        return result;
    return [];
}
/** Standard JSON response wrapper for MCP tools. */
export function json(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
//# sourceMappingURL=runtime.js.map