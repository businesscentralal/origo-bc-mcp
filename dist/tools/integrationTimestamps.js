/**
 * Integration timestamp tools — get/set/reverse_integration_timestamp.
 */
import { z } from "zod";
import { resolveTarget, bcTask, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
const CI_TABLE = "Cloud Events Integration";
function ciTableView(source, tableId) {
    return `SORTING(Source,Table Id,Date & Time) ORDER(Descending) WHERE(Source=CONST(${source}),Table Id=CONST(${tableId}),Reversed=CONST(false))`;
}
export function registerIntegrationTimestampTools(server) {
    server.registerTool("get_integration_timestamp", {
        title: "Get integration timestamp",
        description: "Gets the most recent non-reversed integration timestamp for a source + table pair.",
        inputSchema: {
            source: z.string().describe("Integration source identifier."),
            tableId: z.number().int().describe("BC table ID."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ source, tableId, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Get",
            source: MCP_SOURCE,
            data: JSON.stringify({ tableName: CI_TABLE, tableView: ciTableView(source, tableId), skip: 0, take: 1 }),
            ...(lcid != null ? { lcid } : {}),
        });
        const records = (result.result ?? result.value ?? []);
        if (!records.length) {
            return json({ company: t.companyName, source, tableId, dateTime: null });
        }
        const dateTime = (records[0].primaryKey ?? {}).DateTime ?? null;
        return json({ company: t.companyName, source, tableId, dateTime });
    });
    server.registerTool("set_integration_timestamp", {
        title: "Set integration timestamp",
        description: "Writes an integration timestamp for a source + table pair.",
        inputSchema: {
            source: z.string().describe("Integration source identifier."),
            tableId: z.number().int().describe("BC table ID."),
            dateTime: z.string().describe("ISO 8601 timestamp (e.g. '2026-03-17T12:00:00Z')."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ source, tableId, dateTime, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Set",
            source: MCP_SOURCE,
            subject: CI_TABLE,
            data: JSON.stringify({
                data: [{
                        primaryKey: { Source: String(source), TableId: Number(tableId), DateTime: String(dateTime) },
                        fields: { Reversed: "false" },
                    }],
            }),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, source, tableId, dateTime: String(dateTime), written: 1 });
    });
    server.registerTool("reverse_integration_timestamp", {
        title: "Reverse integration timestamp",
        description: "Marks the most recent integration timestamp for a source + table pair as reversed.",
        inputSchema: {
            source: z.string().describe("Integration source identifier."),
            tableId: z.number().int().describe("BC table ID."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ source, tableId, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const readResult = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Get",
            source: MCP_SOURCE,
            data: JSON.stringify({ tableName: CI_TABLE, tableView: ciTableView(source, tableId), skip: 0, take: 1 }),
            ...(lcid != null ? { lcid } : {}),
        });
        const records = (readResult.result ?? readResult.value ?? []);
        if (!records.length) {
            return json({ company: t.companyName, source, tableId, reversed: false, dateTime: null, message: "No non-reversed record found." });
        }
        const pk = records[0].primaryKey ?? {};
        const dateTime = pk.DateTime;
        await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Set",
            source: MCP_SOURCE,
            subject: CI_TABLE,
            data: JSON.stringify({
                mode: "modify",
                data: [{
                        primaryKey: { Source: String(source), TableId: Number(tableId), DateTime: String(dateTime) },
                        fields: { Reversed: "true" },
                    }],
            }),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, source, tableId, reversed: true, dateTime });
    });
}
//# sourceMappingURL=integrationTimestamps.js.map