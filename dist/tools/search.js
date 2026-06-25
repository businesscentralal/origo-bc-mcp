/**
 * Entity search tools — 10 entity-specific searches + search_records.
 */
import { z } from "zod";
import { resolveTarget, bcTask, toMarkdownTable, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
const ENTITIES = [
    { name: "search_customers", title: "Search customers", table: "Customer", searchFields: ["No.", "Name", "Search Name", "Phone No.", "E-Mail", "VAT Registration No."], resultFields: ["No.", "Name", "Balance (LCY)", "City", "Phone No.", "E-Mail"], description: "Search for customers by number, name, phone, email, or VAT number." },
    { name: "search_items", title: "Search items", table: "Item", searchFields: ["No.", "Description", "Search Description", "Base Unit of Measure", "Vendor No."], resultFields: ["No.", "Description", "Unit Price", "Unit Cost", "Inventory", "Base Unit of Measure", "Type"], description: "Search for items by number, description, unit of measure, or vendor." },
    { name: "search_vendors", title: "Search vendors", table: "Vendor", searchFields: ["No.", "Name", "Search Name", "Phone No.", "E-Mail", "VAT Registration No."], resultFields: ["No.", "Name", "Balance (LCY)", "City", "Phone No.", "E-Mail"], description: "Search for vendors by number, name, phone, email, or VAT number." },
    { name: "search_contacts", title: "Search contacts", table: "Contact", searchFields: ["No.", "Name", "Search Name", "Company Name", "Phone No.", "E-Mail"], resultFields: ["No.", "Name", "Company Name", "Phone No.", "E-Mail", "Type"], description: "Search for contacts by name, company, phone, or email." },
    { name: "search_employees", title: "Search employees", table: "Employee", searchFields: ["No.", "First Name", "Last Name", "Search Name", "Phone No.", "Company E-Mail"], resultFields: ["No.", "First Name", "Last Name", "Job Title", "Phone No.", "Company E-Mail", "Status"], description: "Search for employees by name, phone, or email." },
    { name: "search_gl_accounts", title: "Search GL accounts", table: "G/L Account", searchFields: ["No.", "Name", "Search Name"], resultFields: ["No.", "Name", "Income/Balance", "Debit/Credit", "Account Type", "Direct Posting"], description: "Search for general ledger accounts by number or name." },
    { name: "search_bank_accounts", title: "Search bank accounts", table: "Bank Account", searchFields: ["No.", "Name", "Search Name", "Bank Account No.", "IBAN"], resultFields: ["No.", "Name", "Bank Account No.", "IBAN", "Currency Code", "Balance (LCY)"], description: "Search for bank accounts by number, name, bank account number, or IBAN." },
    { name: "search_resources", title: "Search resources", table: "Resource", searchFields: ["No.", "Name", "Search Name", "Type"], resultFields: ["No.", "Name", "Type", "Base Unit of Measure", "Unit Price", "Direct Unit Cost"], description: "Search for resources by number, name, or type." },
    { name: "search_fixed_assets", title: "Search fixed assets", table: "Fixed Asset", searchFields: ["No.", "Description", "Search Description", "Serial No."], resultFields: ["No.", "Description", "FA Class Code", "FA Subclass Code", "Serial No.", "Inactive"], description: "Search for fixed assets by number, description, or serial number." },
    { name: "search_projects", title: "Search projects", table: "Job", searchFields: ["No.", "Description", "Search Description", "Bill-to Customer No."], resultFields: ["No.", "Description", "Status", "Bill-to Customer No.", "Person Responsible", "Project Manager"], description: "Search for projects (jobs) by number, description, or customer." },
];
async function multiFieldSearch(tenantId, environment, companyId, table, searchFields, resultFields, query, take, lcid) {
    // Resolve field names to numbers
    const fieldsResult = await bcTask(tenantId, environment, companyId, {
        specversion: "1.0",
        type: "Help.Fields.Get",
        source: MCP_SOURCE,
        data: JSON.stringify({ tableName: table }),
        lcid,
    });
    const allFields = (fieldsResult.result ?? fieldsResult.value ?? []);
    const nameToNo = new Map();
    for (const f of allFields) {
        const no = Number(f.id ?? f.number ?? f.fieldNo);
        const name = String(f.name ?? "").trim();
        if (no >= 1 && name)
            nameToNo.set(name.toLowerCase(), no);
    }
    const searchFieldNos = searchFields
        .map((n) => nameToNo.get(n.toLowerCase()))
        .filter((n) => n !== undefined);
    const resultFieldNos = resultFields
        .map((n) => nameToNo.get(n.toLowerCase()))
        .filter((n) => n !== undefined);
    // Build search filter — search each field for the query substring
    const filterParts = searchFieldNos.map((no) => `Field${no}=@*${query}*`);
    const tableView = filterParts.length ? `WHERE(${filterParts.join("|")})` : undefined;
    const baseData = {
        tableName: table,
        skip: 0,
        take,
        ...(resultFieldNos.length ? { fieldNumbers: resultFieldNos } : {}),
    };
    // Try search approach - simple filter first
    try {
        const result = await bcTask(tenantId, environment, companyId, {
            specversion: "1.0",
            type: "Data.Search",
            source: MCP_SOURCE,
            data: JSON.stringify({ ...baseData, query: String(query) }),
            lcid,
        });
        return (result.result ?? result.value ?? []);
    }
    catch {
        // Fallback to Data.Records.Get with filter
        if (tableView)
            baseData.tableView = tableView;
        const result = await bcTask(tenantId, environment, companyId, {
            specversion: "1.0",
            type: "Data.Records.Get",
            source: MCP_SOURCE,
            data: JSON.stringify(baseData),
            lcid,
        });
        return (result.result ?? result.value ?? []);
    }
}
export function registerSearchTools(server) {
    // ── Entity-specific search tools ────────────────────────────────────────
    for (const entity of ENTITIES) {
        server.registerTool(entity.name, {
            title: entity.title,
            description: entity.description,
            inputSchema: {
                query: z.string().describe("Search query — substring match across key fields."),
                take: z.number().int().optional().describe("Max results (default 20, max 100)."),
                lcid: z.number().int().optional(),
                format: z.enum(["json", "markdown"]).optional(),
                companyId: z.string().optional(),
            },
        }, async ({ query, take = 20, lcid = 1033, format = "json", companyId }) => {
            const capTake = Math.min(Number(take) || 20, 100);
            const t = await resolveTarget({ companyId });
            const records = await multiFieldSearch(t.tenantId, t.environment, t.companyId, entity.table, entity.searchFields, entity.resultFields, query, capTake, lcid);
            if (format === "markdown") {
                const flat = records.map((r) => ({ ...(r.primaryKey ?? {}), ...(r.fields ?? {}) }));
                const headers = flat.length ? [...new Set(flat.flatMap((r) => Object.keys(r)))] : [];
                const md = toMarkdownTable(headers, flat.map((r) => headers.map((h) => r[h])));
                return json({ company: t.companyName, entity: entity.table, query, count: records.length, markdown: md });
            }
            return json({ company: t.companyName, entity: entity.table, query, count: records.length, records });
        });
    }
    // ── search_records (generic) ──────────────────────────────────────────
    server.registerTool("search_records", {
        title: "Search records",
        description: "Full-text search across a BC table using Data.Search message type.",
        inputSchema: {
            table: z.string().describe("BC table name to search in."),
            query: z.string().describe("Search query."),
            take: z.number().int().optional().describe("Max results (default 50)."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, query, take = 50, lcid = 1033, companyId }) => {
        const capTake = Math.min(Number(take) || 50, 200);
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Search",
            source: MCP_SOURCE,
            data: JSON.stringify({ tableName: String(table), query: String(query), skip: 0, take: capTake }),
            lcid,
        });
        const records = (result.result ?? result.value ?? []);
        return json({ company: t.companyName, table: String(table), query, count: records.length, records });
    });
}
//# sourceMappingURL=search.js.map