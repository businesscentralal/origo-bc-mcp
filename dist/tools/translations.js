/**
 * Translation tools — get/set field translations. Bifrost translation entries are read and written
 * with the general Data.Records.Get / Data.Records.Set tools on table "Translation ori".
 */
import { z } from "zod";
import { resolveTarget, bcTask, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerTranslationTools(server) {
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