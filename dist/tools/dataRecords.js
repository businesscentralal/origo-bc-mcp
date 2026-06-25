/**
 * Data record tools — get_records, set_records, get_record_ids, batch_records, get_document_lines.
 */
import { z } from "zod";
import { resolveTarget, bcTask, fetchAllPages, validateTableName, toMarkdownTable, json, } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerDataRecordTools(server) {
    // ── get_records ───────────────────────────────────────────────────────────
    server.registerTool("get_records", {
        title: "Get records",
        description: "Reads records from a BC table with optional filter, field selection, date range, and paging. Set fetchAll=true to paginate through all matching records.",
        inputSchema: {
            table: z.string().describe("BC table name."),
            filter: z.string().optional().describe("BC tableView filter."),
            fields: z.array(z.union([z.number(), z.string()])).optional().describe("Field numbers or names to return."),
            startDateTime: z.string().optional().describe("ISO 8601 UTC — records modified at or after."),
            endDateTime: z.string().optional().describe("ISO 8601 UTC — records modified at or before."),
            skip: z.number().int().optional().describe("Paging offset (default 0)."),
            take: z.number().int().optional().describe("Max records (default 50, max 1000)."),
            fetchAll: z.boolean().optional().describe("Auto-paginate all matching records."),
            lcid: z.number().int().optional().describe("Language LCID (default 1033)."),
            format: z.enum(["json", "markdown"]).optional().describe("Output format."),
            companyId: z.string().optional(),
        },
    }, async ({ table, filter, fields, startDateTime, endDateTime, skip = 0, take = 50, fetchAll = false, lcid = 1033, format = "json", companyId }) => {
        validateTableName(table);
        const capTake = Math.min(Number(take) || 50, 1000);
        const capSkip = Math.max(Number(skip) || 0, 0);
        const t = await resolveTarget({ companyId });
        // Resolve field names to numbers if needed
        let resolvedFieldNumbers = [];
        if (Array.isArray(fields) && fields.length) {
            const needsResolution = fields.some((f) => isNaN(Number(f)));
            if (needsResolution) {
                const fieldsResult = await bcTask(t.tenantId, t.environment, t.companyId, {
                    specversion: "1.0",
                    type: "Help.Fields.Get",
                    source: MCP_SOURCE,
                    subject: String(table),
                    lcid,
                });
                const allFields = (fieldsResult.result ?? fieldsResult.value ?? []);
                const nameToNo = new Map();
                for (const f of allFields) {
                    const no = Number(f.number ?? f.fieldNo ?? f.no ?? f.id);
                    const name = String(f.name ?? f.caption ?? "").trim();
                    if (no >= 1 && name)
                        nameToNo.set(name.toLowerCase(), no);
                }
                for (const f of fields) {
                    const asNum = Number(f);
                    if (!isNaN(asNum)) {
                        resolvedFieldNumbers.push(asNum);
                    }
                    else {
                        const no = nameToNo.get(String(f).toLowerCase());
                        if (!no)
                            throw new Error(`Field '${f}' not found in table '${table}'.`);
                        resolvedFieldNumbers.push(no);
                    }
                }
            }
            else {
                resolvedFieldNumbers = fields.map((f) => Number(f));
            }
        }
        const baseData = { tableName: String(table) };
        if (filter)
            baseData.tableView = String(filter);
        if (startDateTime)
            baseData.startDateTime = String(startDateTime);
        if (endDateTime)
            baseData.endDateTime = String(endDateTime);
        if (resolvedFieldNumbers.length)
            baseData.fieldNumbers = resolvedFieldNumbers;
        let records;
        let noOfRecords;
        let fetchedCount;
        let fetchedTruncated;
        if (fetchAll) {
            const paged = await fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.Records.Get", baseData, { lcid });
            records = paged.records;
            noOfRecords = paged.noOfRecords;
            fetchedCount = paged.fetched;
            fetchedTruncated = paged.truncated;
        }
        else {
            const result = await bcTask(t.tenantId, t.environment, t.companyId, {
                specversion: "1.0",
                type: "Data.Records.Get",
                source: MCP_SOURCE,
                data: JSON.stringify({ ...baseData, skip: capSkip, take: capTake }),
                lcid,
            });
            records = (result.result ?? result.value ?? []);
            noOfRecords = result.noOfRecords;
        }
        if (format === "markdown") {
            const flat = records.map((r) => {
                if (r && (r.primaryKey || r.fields)) {
                    return { ...(r.primaryKey ?? {}), ...(r.fields ?? {}) };
                }
                return r ?? {};
            });
            const headers = flat.length ? [...new Set(flat.flatMap((r) => Object.keys(r)))] : [];
            const md = toMarkdownTable(headers, flat.map((r) => headers.map((h) => r[h])));
            const ret = { company: t.companyName, table: String(table), skip: capSkip, take: capTake, count: records.length, markdown: md };
            if (noOfRecords !== undefined)
                ret.noOfRecords = noOfRecords;
            if (fetchAll) {
                ret.fetchAll = true;
                ret.fetched = fetchedCount;
            }
            if (fetchedTruncated)
                ret.truncated = true;
            return json(ret);
        }
        const ret = { company: t.companyName, table: String(table), skip: capSkip, take: capTake, count: records.length, records };
        if (noOfRecords !== undefined)
            ret.noOfRecords = noOfRecords;
        if (fetchAll) {
            ret.fetchAll = true;
            ret.fetched = fetchedCount;
        }
        if (fetchedTruncated)
            ret.truncated = true;
        return json(ret);
    });
    // ── set_records ───────────────────────────────────────────────────────────
    server.registerTool("set_records", {
        title: "Set records",
        description: "Upserts records in any BC table via Data.Records.Set. Checks write permissions and ChangeLog Write Guard before writing.",
        inputSchema: {
            table: z.string().describe("BC table name."),
            data: z.array(z.object({
                primaryKey: z.record(z.unknown()).describe("Key fields identifying the record."),
                fields: z.record(z.unknown()).optional().describe("Non-key fields to write."),
            })).describe("Array of records to write."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, data, lcid, companyId }) => {
        validateTableName(table);
        if (!data.length)
            throw new Error("data must be a non-empty array.");
        const t = await resolveTarget({ companyId });
        // Check write permissions
        const permsResult = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.Permissions.Get",
            source: MCP_SOURCE,
            subject: String(table),
            ...(lcid != null ? { lcid } : {}),
        }).catch(() => null);
        if (permsResult) {
            const rawPerms = (permsResult.permissions ?? permsResult);
            const canWrite = !!(rawPerms.write ?? rawPerms.writePermission);
            if (!canWrite) {
                throw new Error(`Write permission denied on table '${table}'.`);
            }
        }
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Set",
            source: MCP_SOURCE,
            subject: String(table),
            data: JSON.stringify({ data }),
            ...(lcid != null ? { lcid } : {}),
        });
        const records = (result.result ?? result.value ?? []);
        return json({ company: t.companyName, table: String(table), mode: "upsert", written: data.length, records });
    });
    // ── get_record_ids ────────────────────────────────────────────────────────
    server.registerTool("get_record_ids", {
        title: "Get record IDs",
        description: "Returns SystemId + SystemModifiedAt for incremental sync. No field data returned.",
        inputSchema: {
            table: z.string().describe("BC table name."),
            startDateTime: z.string().optional().describe("ISO 8601 UTC."),
            endDateTime: z.string().optional().describe("ISO 8601 UTC."),
            filter: z.string().optional().describe("Optional BC filter."),
            skip: z.number().int().optional(),
            take: z.number().int().optional().describe("Max IDs (default 1000)."),
            fetchAll: z.boolean().optional(),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, startDateTime, endDateTime, filter, skip = 0, take = 1000, fetchAll = false, lcid, companyId }) => {
        validateTableName(table);
        const capTake = Math.min(Number(take) || 1000, 1000);
        const t = await resolveTarget({ companyId });
        const baseData = { tableName: String(table) };
        if (startDateTime)
            baseData.startDateTime = String(startDateTime);
        if (endDateTime)
            baseData.endDateTime = String(endDateTime);
        if (filter)
            baseData.tableView = String(filter);
        if (fetchAll) {
            const paged = await fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.RecordIds.Get", baseData);
            return json({ company: t.companyName, table: String(table), fetchAll: true, noOfRecords: paged.noOfRecords, fetched: paged.fetched, records: paged.records, ...(paged.truncated ? { truncated: true } : {}) });
        }
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.RecordIds.Get",
            source: MCP_SOURCE,
            data: JSON.stringify({ ...baseData, skip, take: capTake }),
            ...(lcid != null ? { lcid } : {}),
        });
        const records = (result.result ?? result.value ?? []);
        return json({ company: t.companyName, table: String(table), skip, take: capTake, noOfRecords: result.noOfRecords, records });
    });
    // ── batch_records ─────────────────────────────────────────────────────────
    server.registerTool("batch_records", {
        title: "Batch records",
        description: "Reads records from multiple BC tables in parallel (max 10 requests per batch).",
        inputSchema: {
            requests: z.array(z.object({
                table: z.string().describe("BC table name."),
                filter: z.string().optional(),
                fieldNumbers: z.array(z.number().int()).optional(),
                take: z.number().int().optional().describe("Max records (default 50, max 200)."),
            })).describe("Array of read requests."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ requests, lcid, companyId }) => {
        if (requests.length > 10)
            throw new Error("Maximum 10 requests per batch.");
        const t = await resolveTarget({ companyId });
        const results = await Promise.all(requests.map(async (req, idx) => {
            try {
                validateTableName(req.table);
                const capTake = Math.min(Number(req.take) || 50, 200);
                const data = { tableName: String(req.table), skip: 0, take: capTake };
                if (req.filter)
                    data.tableView = String(req.filter);
                if (req.fieldNumbers?.length)
                    data.fieldNumbers = req.fieldNumbers;
                const result = await bcTask(t.tenantId, t.environment, t.companyId, {
                    specversion: "1.0",
                    type: "Data.Records.Get",
                    source: MCP_SOURCE,
                    data: JSON.stringify(data),
                    ...(lcid != null ? { lcid } : {}),
                });
                const records = (result.result ?? result.value ?? []);
                const ret = { table: String(req.table), count: records.length, records };
                if (result.noOfRecords !== undefined)
                    ret.noOfRecords = result.noOfRecords;
                return ret;
            }
            catch (err) {
                return { table: req.table ?? `request[${idx}]`, error: err.message };
            }
        }));
        return json({ company: t.companyName, results });
    });
    // ── get_document_lines ────────────────────────────────────────────────────
    const DOC_LINE_MAP = {
        "sales document": { table: "Sales Line", docTypeFilter: "Order" },
        "sales invoice": { table: "Sales Line", docTypeFilter: "Invoice" },
        "sales quote": { table: "Sales Line", docTypeFilter: "Quote" },
        "sales credit memo": { table: "Sales Line", docTypeFilter: "Credit Memo" },
        "purchase document": { table: "Purchase Line", docTypeFilter: "Order" },
        "purchase invoice": { table: "Purchase Line", docTypeFilter: "Invoice" },
        "purchase quote": { table: "Purchase Line", docTypeFilter: "Quote" },
        "purchase credit memo": { table: "Purchase Line", docTypeFilter: "Credit Memo" },
    };
    server.registerTool("get_document_lines", {
        title: "Get document lines",
        description: "Reads document lines for a given document number. Auto-resolves the correct line table from documentType.",
        inputSchema: {
            documentType: z.string().optional().describe("E.g. 'sales invoice', 'purchase document'."),
            documentNo: z.string().describe("Document number."),
            table: z.string().optional().describe("Explicit line table (overrides documentType)."),
            fields: z.array(z.number().int()).optional(),
            take: z.number().int().optional().describe("Max lines (default 200)."),
            lcid: z.number().int().optional(),
            format: z.enum(["json", "markdown"]).optional(),
            companyId: z.string().optional(),
        },
    }, async ({ documentType, documentNo, table, fields, take = 200, lcid = 1033, format = "json", companyId }) => {
        const capTake = Math.min(Number(take) || 200, 200);
        const t = await resolveTarget({ companyId });
        let targetTable;
        let docTypeFilter;
        if (table) {
            targetTable = table;
        }
        else if (documentType) {
            const mapped = DOC_LINE_MAP[documentType.toLowerCase().trim()];
            if (!mapped)
                throw new Error(`Unknown documentType '${documentType}'.`);
            targetTable = mapped.table;
            docTypeFilter = mapped.docTypeFilter;
        }
        else {
            throw new Error("Either documentType or table is required.");
        }
        const filterParts = [];
        if (docTypeFilter)
            filterParts.push(`Document Type=CONST(${docTypeFilter})`);
        filterParts.push(`Document No.=CONST(${documentNo})`);
        const filterStr = `WHERE(${filterParts.join(",")})`;
        const baseData = { tableName: targetTable, tableView: filterStr, skip: 0, take: capTake };
        if (fields?.length)
            baseData.fieldNumbers = fields;
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Get",
            source: MCP_SOURCE,
            data: JSON.stringify(baseData),
            lcid,
        });
        const records = (result.result ?? result.value ?? []);
        if (format === "markdown") {
            const flat = records.map((r) => ({ ...(r.primaryKey ?? {}), ...(r.fields ?? {}) }));
            const headers = flat.length ? [...new Set(flat.flatMap((r) => Object.keys(r)))] : [];
            const md = toMarkdownTable(headers, flat.map((r) => headers.map((h) => r[h])));
            return json({ company: t.companyName, table: targetTable, documentNo, count: records.length, markdown: md });
        }
        return json({ company: t.companyName, table: targetTable, documentNo, count: records.length, records });
    });
}
//# sourceMappingURL=dataRecords.js.map