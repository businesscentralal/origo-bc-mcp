/**
 * Translation tools — list_translations, set_translations, get/set field translations.
 */
import { z } from "zod";
import { resolveTarget, bcTask, fetchAllPages, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerTranslationTools(server) {
    server.registerTool("list_translations", {
        title: "List translations",
        description: "Lists Cloud Event Translation entries for a given source and language. Use missingOnly to find untranslated strings.",
        inputSchema: {
            source: z.string().describe("Translation source identifier."),
            lcid: z.number().int().describe("Windows Language ID (e.g. 1033 for English, 1039 for Icelandic)."),
            missingOnly: z.boolean().optional().describe("Only return entries with missing translations."),
            fetchAll: z.boolean().optional().describe("Auto-paginate all results."),
            skip: z.number().int().optional(),
            take: z.number().int().optional().describe("Max results (default 500, max 1000)."),
            companyId: z.string().optional(),
        },
    }, async ({ source, lcid, missingOnly = false, fetchAll = false, skip = 0, take = 500, companyId }) => {
        const capTake = Math.min(Number(take) || 500, 1000);
        const capSkip = Math.max(Number(skip) || 0, 0);
        const t = await resolveTarget({ companyId });
        const tableView = `WHERE(Windows Language ID=CONST(${Number(lcid)}),Source=CONST(${source}))`;
        const baseData = { tableName: "Cloud Event Translation", tableView };
        let rawRecords;
        let noOfRecords;
        let fetchedCount;
        let fetchedTruncated;
        if (fetchAll) {
            const paged = await fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.Records.Get", baseData);
            rawRecords = paged.records;
            noOfRecords = paged.noOfRecords;
            fetchedCount = paged.fetched;
            fetchedTruncated = paged.truncated;
        }
        else {
            const result = await bcTask(t.tenantId, t.environment, t.companyId, {
                specversion: "1.0",
                type: "Data.Records.Get",
                source: MCP_SOURCE,
                subject: "Cloud Event Translation",
                data: JSON.stringify({ tableView, skip: capSkip, take: capTake }),
                lcid,
            });
            rawRecords = (result.result ?? result.value ?? []);
            noOfRecords = result.noOfRecords;
        }
        let records = rawRecords.map((r) => ({
            sourceText: String((r.primaryKey ?? {}).SourceText ?? ""),
            targetText: String((r.fields ?? {}).TargetText ?? ""),
        }));
        if (missingOnly)
            records = records.filter((r) => !r.targetText.trim());
        const ret = {
            company: t.companyName, source, lcid, skip: capSkip, take: capTake,
            total: records.length, missing: records.filter((r) => !r.targetText.trim()).length,
            translations: records,
        };
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
    server.registerTool("set_translations", {
        title: "Set translations",
        description: "Writes translation entries for a given source and language.",
        inputSchema: {
            source: z.string().describe("Translation source identifier."),
            lcid: z.number().int().describe("Windows Language ID."),
            translations: z.array(z.object({
                sourceText: z.string(),
                targetText: z.string(),
            })).describe("Array of {sourceText, targetText} pairs."),
            companyId: z.string().optional(),
        },
    }, async ({ source, lcid, translations, companyId }) => {
        if (!translations.length)
            throw new Error("translations must be a non-empty array.");
        const t = await resolveTarget({ companyId });
        const data = translations.map((tr) => ({
            primaryKey: {
                Source: source,
                WindowsLanguageID: String(Number(lcid)),
                SourceText: String(tr.sourceText),
            },
            fields: { TargetText: String(tr.targetText || "") },
        }));
        await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Set",
            source: MCP_SOURCE,
            subject: "Cloud Event Translation",
            data: JSON.stringify({ data }),
            lcid,
        });
        return json({ company: t.companyName, source, lcid, written: translations.length });
    });
    server.registerTool("get_field_translation", {
        title: "Get field translation",
        description: "Gets a specific field translation for a record.",
        inputSchema: {
            table: z.string().describe("Table name or number."),
            systemId: z.string().describe("Record SystemId GUID."),
            fieldId: z.number().int().describe("Field number."),
            lcid: z.number().int().describe("Windows Language ID."),
            companyId: z.string().optional(),
        },
    }, async ({ table, systemId, fieldId, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Field.Translation.Get",
            source: MCP_SOURCE,
            subject: String(table),
            data: JSON.stringify({ systemId: String(systemId), fieldId: Number(fieldId), lcid: Number(lcid) }),
        });
        return json({ company: t.companyName, ...result });
    });
    server.registerTool("set_field_translation", {
        title: "Set field translation",
        description: "Sets a field translation for a record.",
        inputSchema: {
            table: z.string().describe("Table name or number."),
            systemId: z.string().describe("Record SystemId GUID."),
            fieldId: z.number().int().describe("Field number."),
            lcid: z.number().int().describe("Windows Language ID."),
            value: z.string().optional().describe("Translation value."),
            companyId: z.string().optional(),
        },
    }, async ({ table, systemId, fieldId, lcid, value, companyId }) => {
        const t = await resolveTarget({ companyId });
        const data = { systemId: String(systemId), fieldId: Number(fieldId), lcid: Number(lcid) };
        if (value !== undefined)
            data.value = String(value);
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Field.Translation.Set",
            source: MCP_SOURCE,
            subject: String(table),
            data: JSON.stringify(data),
            lcid,
        });
        return json({ company: t.companyName, ...result });
    });
    server.registerTool("get_field_translations", {
        title: "Get field translations",
        description: "Gets all translations for a record's fields.",
        inputSchema: {
            table: z.string().describe("Table name or number."),
            systemId: z.string().describe("Record SystemId GUID."),
            fieldId: z.number().int().optional().describe("Specific field number."),
            lcid: z.number().int().optional().describe("Specific language."),
            companyId: z.string().optional(),
        },
    }, async ({ table, systemId, fieldId, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const data = { systemId: String(systemId) };
        if (fieldId != null)
            data.fieldId = Number(fieldId);
        if (lcid != null)
            data.lcid = Number(lcid);
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Field.Translations.Get",
            source: MCP_SOURCE,
            subject: String(table),
            data: JSON.stringify(data),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, ...result });
    });
}
//# sourceMappingURL=translations.js.map