/**
 * Totals tools — get_record_count, get_decimal_total.
 */
import { z } from "zod";
import { resolveTarget, bcTask, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerTotalsTools(server) {
    server.registerTool("get_record_count", {
        title: "Get record count",
        description: "Returns the number of records matching a table view filter.",
        inputSchema: {
            table: z.string().describe("BC table name."),
            filter: z.string().optional().describe("BC tableView filter."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, filter, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const data = { tableName: String(table), skip: 0, take: 1, fieldNumbers: [1] };
        if (filter)
            data.tableView = String(filter);
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Records.Get",
            source: MCP_SOURCE,
            data: JSON.stringify(data),
            ...(lcid != null ? { lcid } : {}),
        });
        const count = result.noOfRecords ?? (Array.isArray(result.result) ? result.result.length : undefined);
        return json({ company: t.companyName, table: String(table), filter: filter ?? null, count });
    });
    server.registerTool("get_decimal_total", {
        title: "Get decimal total",
        description: "Sums one or more decimal SumIndexFields across all records matching a filter. Uses CalcSums on the BC side for efficiency. Fields must be specified by field number.",
        inputSchema: {
            table: z.string().describe("BC table name."),
            fieldNumbers: z.array(z.number().int()).describe("Field numbers to sum (must be Decimal SumIndexFields)."),
            filter: z.string().optional().describe("BC tableView filter (SetView format)."),
            groupBy: z.union([z.string(), z.number().int()]).optional().describe("Field name or number to group by."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ table, fieldNumbers, filter, groupBy, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const data = { tableName: String(table), fieldNumbers };
        if (filter)
            data.tableView = String(filter);
        if (groupBy != null)
            data.groupBy = groupBy;
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Data.Totals.Get",
            source: MCP_SOURCE,
            data: JSON.stringify(data),
            ...(lcid != null ? { lcid } : {}),
        });
        const rows = Array.isArray(result.result) ? result.result : Array.isArray(result.value) ? result.value : [];
        return json({ company: t.companyName, table: String(table), fieldNumbers, result: rows });
    });
}
//# sourceMappingURL=totals.js.map