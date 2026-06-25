/**
 * Memory & config tools — company/user/default memory + set_config, get_config.
 */
import { z } from "zod";
import { resolveTarget, bcTask, fetchAllPages, json } from "../bc/runtime.js";
import { resolveSetupConn, getSetupAccessToken } from "../bc/setupConn.js";
import { listCompanies } from "../bc/client.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
const CS_TABLE = "Cloud Event Config Store";
const MEMORY_LIST_BATCH_SIZE = 500;
const MEMORY_LIST_MAX_TAKE = 5000;
const MEMORY_GET_BATCH_SIZE = 100;
const MEMORY_GET_MAX_TAKE = 500;
// ── Crypto helpers (encrypt/decrypt for config store) ───────────────────────
import { getEncryptionKey } from "../config.js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
function encryptData(plaintext) {
    const key = getEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
}
function decryptData(ciphertext) {
    const key = getEncryptionKey();
    const buf = Buffer.from(ciphertext, "base64");
    if (buf.length < 28)
        throw new Error("ciphertext too short");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
// ── Setup connection bcTask wrapper ─────────────────────────────────────────
async function setupBcTask(companyId, envelope) {
    const setup = resolveSetupConn();
    const token = await getSetupAccessToken();
    const BC_HOST = "api.businesscentral.dynamics.com";
    const taskUrl = `https://${BC_HOST}/v2.0/${setup.tenantId}/${setup.environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
    const res = await fetch(taskUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
    });
    const task = (await res.json());
    if (task.status === "Error")
        throw new Error(String(task.error || JSON.stringify(task)));
    if (task.data) {
        const dataStr = String(task.data);
        if (dataStr.startsWith(`https://${BC_HOST}/`)) {
            const dataRes = await fetch(dataStr, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
            });
            const raw = await dataRes.text();
            try {
                return JSON.parse(raw);
            }
            catch {
                return { result: raw };
            }
        }
    }
    return task;
}
async function resolveSetupCompany() {
    const setup = resolveSetupConn();
    if (setup.companyId)
        return { id: setup.companyId, name: setup.companyId };
    const companies = await listCompanies(setup.tenantId, setup.environment);
    if (!companies.length)
        throw new Error("No companies in setup environment.");
    return { id: companies[0].id, name: companies[0].displayName };
}
// ── Registration ────────────────────────────────────────────────────────────
function registerMemoryTool(server, name, title, description, messageType, mode, scope) {
    if (mode === "set") {
        server.registerTool(name, {
            title,
            description,
            inputSchema: {
                id: z.string().optional().describe("Memory entry ID."),
                description: z.string().optional().describe("Short description."),
                memory: z.string().optional().describe("Memory content."),
                lcid: z.number().int().optional(),
                companyId: z.string().optional(),
            },
        }, async ({ id, description: desc, memory, lcid, companyId }) => {
            if (!desc && !memory && !id)
                throw new Error("At least one of 'id', 'description', or 'memory' is required.");
            const record = {};
            if (id)
                record.id = String(id);
            if (desc != null)
                record.description = String(desc);
            if (memory != null)
                record.memory = String(memory);
            if (scope === "default") {
                const setupCompany = await resolveSetupCompany();
                const result = await setupBcTask(setupCompany.id, {
                    specversion: "1.0", type: messageType, source: MCP_SOURCE,
                    data: JSON.stringify({ data: [record] }),
                    ...(lcid != null ? { lcid } : {}),
                });
                return json({ company: setupCompany.name, ...result });
            }
            const t = await resolveTarget({ companyId });
            const result = await bcTask(t.tenantId, t.environment, t.companyId, {
                specversion: "1.0", type: messageType, source: MCP_SOURCE,
                data: JSON.stringify({ data: [record] }),
                ...(lcid != null ? { lcid } : {}),
            });
            return json({ company: t.companyName, ...result });
        });
        return;
    }
    // list or get
    const maxTake = mode === "list" ? MEMORY_LIST_MAX_TAKE : MEMORY_GET_MAX_TAKE;
    const defaultTake = mode === "list" ? 50 : 10;
    const batchSize = mode === "list" ? MEMORY_LIST_BATCH_SIZE : MEMORY_GET_BATCH_SIZE;
    server.registerTool(name, {
        title,
        description,
        inputSchema: {
            tableView: z.string().optional().describe("Optional filter."),
            fetchAll: z.boolean().optional().describe("Auto-paginate."),
            skip: z.number().int().optional(),
            take: z.number().int().optional(),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ tableView, fetchAll = false, skip = 0, take, lcid, companyId }) => {
        const capTake = Math.min(Number(take) || defaultTake, maxTake);
        const capSkip = Math.max(Number(skip) || 0, 0);
        const baseData = {};
        if (tableView)
            baseData.tableView = String(tableView);
        if (scope === "default") {
            const setupCompany = await resolveSetupCompany();
            if (fetchAll) {
                const paged = await fetchAllPages(resolveSetupConn().tenantId, resolveSetupConn().environment, setupCompany.id, messageType, baseData, { lcid: lcid ?? undefined }, batchSize);
                return json({ company: setupCompany.name, skip: 0, take: paged.fetched, fetchAll: true, ...paged });
            }
            const result = await setupBcTask(setupCompany.id, {
                specversion: "1.0", type: messageType, source: MCP_SOURCE,
                data: JSON.stringify({ ...baseData, skip: capSkip, take: capTake }),
                ...(lcid != null ? { lcid } : {}),
            });
            return json({ company: setupCompany.name, skip: capSkip, take: capTake, ...result });
        }
        const t = await resolveTarget({ companyId });
        if (fetchAll) {
            const paged = await fetchAllPages(t.tenantId, t.environment, t.companyId, messageType, baseData, { lcid: lcid ?? undefined }, batchSize);
            return json({ company: t.companyName, skip: 0, take: paged.fetched, fetchAll: true, ...paged });
        }
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0", type: messageType, source: MCP_SOURCE,
            data: JSON.stringify({ ...baseData, skip: capSkip, take: capTake }),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, skip: capSkip, take: capTake, ...result });
    });
}
export function registerMemoryConfigTools(server) {
    // Company memory
    registerMemoryTool(server, "list_company_memory", "List company memory", "Lists company-scoped memory entries.", "Memory.Company.List", "list", "company");
    registerMemoryTool(server, "get_company_memory", "Get company memory", "Gets company-scoped memory entry content.", "Memory.Company.Get", "get", "company");
    registerMemoryTool(server, "set_company_memory", "Set company memory", "Creates or updates a company-scoped memory entry.", "Memory.Company.Set", "set", "company");
    // User memory
    registerMemoryTool(server, "list_user_memory", "List user memory", "Lists user-scoped memory entries.", "Memory.User.List", "list", "user");
    registerMemoryTool(server, "get_user_memory", "Get user memory", "Gets user-scoped memory entry content.", "Memory.User.Get", "get", "user");
    registerMemoryTool(server, "set_user_memory", "Set user memory", "Creates or updates a user-scoped memory entry.", "Memory.User.Set", "set", "user");
    // Default memory (setup connection)
    registerMemoryTool(server, "list_default_memory", "List default memory", "Lists default memory entries from the central setup environment.", "Memory.Company.List", "list", "default");
    registerMemoryTool(server, "get_default_memory", "Get default memory", "Gets default memory entry content from the central setup environment.", "Memory.Company.Get", "get", "default");
    // ── set_config ──────────────────────────────────────────────────────────
    server.registerTool("set_config", {
        title: "Set config",
        description: "Stores a configuration value in the Cloud Event Config Store. Optionally encrypts with AES-256-GCM.",
        inputSchema: {
            source: z.string().describe("Config source identifier."),
            id: z.string().describe("Config entry ID."),
            data: z.unknown().describe("Data to store (string or JSON object)."),
            encrypt: z.boolean().optional().describe("Encrypt the data before storing."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ source, id, data, encrypt = false, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        let dataString = typeof data === "string" ? data : JSON.stringify(data);
        if (encrypt)
            dataString = encryptData(dataString);
        const blobValue = Buffer.from(dataString).toString("base64");
        await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Set",
            source: MCP_SOURCE,
            subject: CS_TABLE,
            data: JSON.stringify({
                mode: "upsert",
                data: [{ primaryKey: { Source: String(source), Id: String(id) }, fields: { Data: blobValue } }],
            }),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, source, id, encrypted: encrypt, written: 1 });
    });
    // ── get_config ──────────────────────────────────────────────────────────
    server.registerTool("get_config", {
        title: "Get config",
        description: "Reads a configuration value from the Cloud Event Config Store.",
        inputSchema: {
            source: z.string().describe("Config source identifier."),
            id: z.string().describe("Config entry ID."),
            decrypt: z.boolean().optional().describe("Decrypt the stored value."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ source, id, decrypt = false, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Get",
            source: MCP_SOURCE,
            data: JSON.stringify({
                tableName: CS_TABLE,
                tableView: `WHERE(Source=CONST(${source}),Id=CONST(${id}))`,
                skip: 0, take: 1,
            }),
            ...(lcid != null ? { lcid } : {}),
        });
        const records = (result.result ?? result.value ?? []);
        if (!records.length)
            return json({ company: t.companyName, source, id, found: false });
        const blobBase64 = String((records[0].fields ?? {}).Data ?? "");
        let rawString = Buffer.from(blobBase64, "base64").toString("utf8");
        if (decrypt)
            rawString = decryptData(rawString);
        let parsed;
        try {
            parsed = JSON.parse(rawString);
        }
        catch {
            parsed = rawString;
        }
        return json({ company: t.companyName, source, id, found: true, encrypted: decrypt, data: parsed });
    });
}
//# sourceMappingURL=memoryConfig.js.map