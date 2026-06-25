/**
 * Table metadata & schema tools — list_tables, get_table_info, get_table_fields,
 * get_table_relations, get_table_permissions, get_page_url.
 */
import { z } from "zod";
import { resolveTarget, bcTask, validateTableName, toMarkdownTable, json, } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerTableMetadataTools(server) {
    server.registerTool("list_tables", {
        title: "List BC tables",
        description: "Lists tables available in the Business Central company. Each entry includes id, name, caption, dataPerCompany, namespace, and readRestricted/writeRestricted booleans. Supports substring filter and paging.",
        inputSchema: {
            lcid: z.number().int().optional().describe("Language LCID (default 1033)."),
            filter: z.string().optional().describe("Substring filter on table name or caption."),
            take: z.number().int().optional().describe("Max tables to return (default 200, max 500)."),
            skip: z.number().int().optional().describe("Paging offset (default 0)."),
            companyId: z.string().optional().describe("Target company GUID or name."),
        },
    }, async ({ lcid = 1033, filter, take = 200, skip = 0, companyId }) => {
        const t = await resolveTarget({ companyId });
        const capTake = Math.min(Number(take) || 200, 500);
        const capSkip = Math.max(Number(skip) || 0, 0);
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.Tables.Get",
            source: MCP_SOURCE,
            lcid,
        });
        let tables = (result.result ?? result.value ?? []);
        if (filter) {
            const lf = filter.toLowerCase();
            tables = tables.filter((tb) => String(tb.name ?? "").toLowerCase().includes(lf) ||
                String(tb.caption ?? "").toLowerCase().includes(lf));
        }
        const total = tables.length;
        tables = tables.slice(capSkip, capSkip + capTake);
        return json({ company: t.companyName, total, skip: capSkip, take: capTake, tableCount: tables.length, tables });
    });
    server.registerTool("get_table_info", {
        title: "Get table info",
        description: "Gets summary information about a specific Business Central table.",
        inputSchema: {
            table: z.string().describe("Table name or number."),
            lcid: z.number().int().optional().describe("Language LCID (default 1033)."),
            companyId: z.string().optional(),
        },
    }, async ({ table, lcid = 1033, companyId }) => {
        validateTableName(table);
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.Tables.Get",
            source: MCP_SOURCE,
            subject: String(table),
            lcid,
        });
        const tableData = (result.result?.[0]) ?? result;
        return json({ company: t.companyName, table: tableData });
    });
    server.registerTool("get_table_fields", {
        title: "Get table fields",
        description: "Gets all fields for a BC table — names, JSON keys, types, lengths, PK membership, relation indicators, and per-field read/write restrictions.",
        inputSchema: {
            table: z.string().describe("Table name or number."),
            lcid: z.number().int().optional().describe("Language LCID (default 1033)."),
            format: z.enum(["json", "markdown"]).optional().describe("Output format (default json)."),
            companyId: z.string().optional(),
        },
    }, async ({ table, lcid = 1033, format = "json", companyId }) => {
        validateTableName(table);
        const t = await resolveTarget({ companyId });
        const [fieldsResult, permsResult] = await Promise.all([
            bcTask(t.tenantId, t.environment, t.companyId, {
                specversion: "1.0",
                type: "Help.Fields.Get",
                source: MCP_SOURCE,
                data: JSON.stringify({ tableName: String(table) }),
                lcid,
            }),
            bcTask(t.tenantId, t.environment, t.companyId, {
                specversion: "1.0",
                type: "Help.Permissions.Get",
                source: MCP_SOURCE,
                subject: String(table),
                lcid,
            }).catch(() => null),
        ]);
        const fields = (fieldsResult.result ?? fieldsResult.value ?? fieldsResult.fields ?? []);
        const rawPerms = permsResult ? (permsResult.permissions ?? permsResult) : null;
        const permissions = rawPerms
            ? {
                read: !!(rawPerms.read ?? rawPerms.readPermission),
                write: !!(rawPerms.write ?? rawPerms.writePermission),
            }
            : null;
        if (format === "markdown") {
            const md = toMarkdownTable(["#", "Name", "JSON Key", "Caption", "Type", "Len", "Class", "PK", "Rel", "R", "W"], fields.map((f) => [
                f.id, f.name, f.jsonName, f.caption, f.type,
                f.len ?? "", f.class ?? "", f.isPartOfPrimaryKey ? "✓" : "",
                f.hasTableRelation ? "✓" : "", f.readRestricted ? "✓" : "", f.writeRestricted ? "✓" : "",
            ]));
            return json({ company: t.companyName, table: String(table), permissions, fieldCount: fields.length, markdown: md });
        }
        return json({ company: t.companyName, table: String(table), permissions, fieldCount: fields.length, fields });
    });
    server.registerTool("get_table_relations", {
        title: "Get table relations",
        description: "Returns foreign-key relationships for a specific field including conditional branches and reverse relations.",
        inputSchema: {
            table: z.string().describe("Table name or number."),
            fieldId: z.number().int().optional().describe("Field number."),
            fieldName: z.string().optional().describe("Field name (used if fieldId not given)."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, fieldId, fieldName, lcid, companyId }) => {
        validateTableName(table);
        if (fieldId == null && !fieldName)
            throw new Error("Either fieldId or fieldName is required.");
        const t = await resolveTarget({ companyId });
        const data = { tableName: String(table) };
        if (fieldId != null)
            data.fieldId = fieldId;
        else
            data.fieldName = fieldName;
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.TableRelations.Get",
            source: MCP_SOURCE,
            data: JSON.stringify(data),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({
            company: t.companyName,
            tableId: result.tableId,
            tableName: result.tableName,
            relationCount: result.relationCount ?? (result.relations ?? []).length,
            relations: result.relations ?? [],
            relatedToCount: result.relatedToCount ?? (result.relatedTo ?? []).length,
            relatedTo: result.relatedTo ?? [],
        });
    });
    server.registerTool("get_table_permissions", {
        title: "Get table permissions",
        description: "Returns BC read/write permissions for the calling principal on a table.",
        inputSchema: {
            table: z.string().describe("BC table name."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, lcid, companyId }) => {
        validateTableName(table);
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.Permissions.Get",
            source: MCP_SOURCE,
            subject: String(table),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, table: String(table), ...result });
    });
    server.registerTool("get_page_url", {
        title: "Get BC page URL",
        description: "Returns the Business Central Web Client URL to access a record.",
        inputSchema: {
            table: z.string().describe("Table name or number."),
            id: z.string().describe("Record SystemId GUID."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, id, lcid, companyId }) => {
        validateTableName(table);
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.PageUrl.Get",
            source: MCP_SOURCE,
            data: JSON.stringify({ tableName: String(table), id: String(id) }),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, table: String(table), id: String(id), ...result });
    });
}
//# sourceMappingURL=tableMetadata.js.map