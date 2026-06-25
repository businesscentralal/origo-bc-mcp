/**
 * Aging tools — compute_customer_aging, compute_vendor_aging.
 */
import { z } from "zod";
import { resolveTarget, bcTask, toMarkdownTable, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
function buildAgingEnvelope(entityType, filter, asOfDate, buckets, lcid) {
    const data = { entityType };
    if (filter)
        data.filter = String(filter);
    if (asOfDate)
        data.asOfDate = String(asOfDate);
    if (buckets)
        data.buckets = String(buckets);
    return {
        specversion: "1.0",
        type: "Data.Aging.Compute",
        source: MCP_SOURCE,
        data: JSON.stringify(data),
        ...(lcid != null ? { lcid } : {}),
    };
}
export function registerAgingTools(server) {
    server.registerTool("compute_customer_aging", {
        title: "Customer aging",
        description: "Computes customer aging breakdown — overdue buckets (Current, 1-30, 31-60, 61-90, 90+) with totals.",
        inputSchema: {
            filter: z.string().optional().describe("Filter customers (e.g. 'No.=10000..20000')."),
            asOfDate: z.string().optional().describe("Aging as-of date (YYYY-MM-DD). Defaults to today."),
            buckets: z.string().optional().describe("Custom bucket definition."),
            lcid: z.number().int().optional(),
            format: z.enum(["json", "markdown"]).optional(),
            companyId: z.string().optional(),
        },
    }, async ({ filter, asOfDate, buckets, lcid, format = "json", companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, buildAgingEnvelope("Customer", filter, asOfDate, buckets, lcid));
        const records = (result.result ?? result.value ?? []);
        if (format === "markdown") {
            const flat = records.map((r) => ({ ...r }));
            const headers = flat.length ? Object.keys(flat[0]) : [];
            const md = toMarkdownTable(headers, flat.map((r) => headers.map((h) => r[h])));
            return json({ company: t.companyName, type: "Customer", count: records.length, markdown: md });
        }
        return json({ company: t.companyName, type: "Customer", count: records.length, ...result });
    });
    server.registerTool("compute_vendor_aging", {
        title: "Vendor aging",
        description: "Computes vendor aging breakdown — overdue buckets (Current, 1-30, 31-60, 61-90, 90+) with totals.",
        inputSchema: {
            filter: z.string().optional().describe("Filter vendors."),
            asOfDate: z.string().optional().describe("Aging as-of date (YYYY-MM-DD)."),
            buckets: z.string().optional().describe("Custom bucket definition."),
            lcid: z.number().int().optional(),
            format: z.enum(["json", "markdown"]).optional(),
            companyId: z.string().optional(),
        },
    }, async ({ filter, asOfDate, buckets, lcid, format = "json", companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, buildAgingEnvelope("Vendor", filter, asOfDate, buckets, lcid));
        const records = (result.result ?? result.value ?? []);
        if (format === "markdown") {
            const flat = records.map((r) => ({ ...r }));
            const headers = flat.length ? Object.keys(flat[0]) : [];
            const md = toMarkdownTable(headers, flat.map((r) => headers.map((h) => r[h])));
            return json({ company: t.companyName, type: "Vendor", count: records.length, markdown: md });
        }
        return json({ company: t.companyName, type: "Vendor", count: records.length, ...result });
    });
}
//# sourceMappingURL=aging.js.map