/**
 * Aging tools — compute_customer_aging, compute_vendor_aging.
 *
 * Implementation: fetches all open ledger entries via Data.Records.Get
 * and computes aging buckets client-side. No fictional message type needed.
 */
import { z } from "zod";
import { resolveTarget, fetchAllPages, toMarkdownTable, json } from "../bc/runtime.js";
function buildBucketDefs(bucketDays) {
    const defs = [
        { key: "notYetDue", label: "Not Yet Due", minDays: -Infinity, maxDays: -1 },
    ];
    let prev = 0;
    for (const days of bucketDays) {
        defs.push({
            key: `overdue_${prev + 1}_${days}`,
            label: prev === 0 ? `1–${days} Days` : `${prev + 1}–${days} Days`,
            minDays: prev + 1,
            maxDays: days,
        });
        prev = days;
    }
    defs.push({ key: `overdue_${prev + 1}_plus`, label: `${prev + 1}+ Days`, minDays: prev + 1, maxDays: Infinity });
    return defs;
}
/** Case-insensitive key finder — checks exact then partial match. */
function findKey(keys, candidates) {
    const lc = new Map(keys.map((k) => [k.toLowerCase(), k]));
    for (const c of candidates) {
        const hit = lc.get(c.toLowerCase());
        if (hit)
            return hit;
    }
    for (const c of candidates) {
        const slug = c.toLowerCase().replace(/[^a-z0-9]/g, "");
        const hit = keys.find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "").includes(slug));
        if (hit)
            return hit;
    }
    return undefined;
}
async function computeAging(t, entityType, filter, asOfDate, buckets, lcid) {
    const tableName = entityType === "Customer" ? "Cust. Ledger Entry" : "Vendor Ledger Entry";
    const asOf = asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
        ? asOfDate
        : new Date().toISOString().slice(0, 10);
    const asOfMs = new Date(asOf + "T00:00:00Z").getTime();
    const bucketDays = buckets
        ? buckets.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0).sort((a, b) => a - b)
        : [30, 60, 90];
    const bucketDefs = buildBucketDefs(bucketDays);
    // Build BC tableView filter — only open entries
    let tableView = "WHERE(Open=CONST(1))";
    if (filter) {
        const inner = filter.match(/^WHERE\s*\(([\s\S]*)\)$/i);
        tableView = `WHERE(Open=CONST(1),${inner ? inner[1] : filter})`;
    }
    const { records, fetched, truncated } = await fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.Records.Get", { tableName, tableView }, lcid != null ? { lcid } : {});
    if (truncated) {
        return { company: t.companyName, type: entityType, error: `Too many open entries (fetched ${fetched}). Apply a filter to narrow results.`, truncated: true };
    }
    if (!records.length) {
        return { company: t.companyName, type: entityType, asOfDate: asOf, count: 0, rows: [], summary: { count: 0, totalBalance: 0 } };
    }
    // Flatten record structure
    const entries = records.map((r) => ({
        ...(r.primaryKey ?? {}),
        ...(r.fields ?? {}),
    }));
    const allKeys = Object.keys(entries[0]);
    // Detect field keys
    const noKey = findKey(allKeys, entityType === "Customer"
        ? ["CustomerNo_", "Customer No_", "CustNo_"]
        : ["VendorNo_", "Vendor No_"]);
    const dueDateKey = findKey(allKeys, ["DueDate", "Due Date"]);
    const remainingKey = findKey(allKeys, ["RemainingAmt_LCY_", "RemainingAmtLCY", "RemainingAmt_LCY", "Remaining Amt_ (LCY)"]);
    if (!noKey || !dueDateKey || !remainingKey) {
        return {
            company: t.companyName, type: entityType,
            error: `Could not find required fields (entityNo=${noKey ?? "?"}, dueDate=${dueDateKey ?? "?"}, remaining=${remainingKey ?? "?"}).`,
            availableKeys: allKeys,
        };
    }
    // Aggregate by entity no.
    const byNo = new Map();
    for (const entry of entries) {
        const no = String(entry[noKey] ?? "");
        if (!no)
            continue;
        const dueDateStr = String(entry[dueDateKey] ?? "");
        const amount = parseFloat(String(entry[remainingKey] ?? "0")) || 0;
        const daysOverdue = !dueDateStr || dueDateStr.startsWith("0001")
            ? 0
            : Math.floor((asOfMs - new Date(dueDateStr + "T00:00:00Z").getTime()) / 86_400_000);
        if (!byNo.has(no)) {
            byNo.set(no, Object.fromEntries([...bucketDefs.map((b) => [b.key, 0]), ["__total__", 0]]));
        }
        const row = byNo.get(no);
        const bucket = bucketDefs.find((b) => daysOverdue >= b.minDays && daysOverdue <= b.maxDays) ?? bucketDefs[bucketDefs.length - 1];
        row[bucket.key] = (row[bucket.key] || 0) + amount;
        row["__total__"] = (row["__total__"] || 0) + amount;
    }
    const rows = [...byNo.entries()]
        .map(([no, bkts]) => ({ no, ...Object.fromEntries(Object.entries(bkts).filter(([k]) => k !== "__total__")), total: bkts["__total__"] }))
        .sort((a, b) => (b.total || 0) - (a.total || 0));
    const summary = { count: rows.length, totalBalance: 0 };
    for (const b of bucketDefs)
        summary[b.key] = 0;
    for (const row of rows) {
        for (const b of bucketDefs)
            summary[b.key] = (summary[b.key] ?? 0) + (row[b.key] || 0);
        summary["totalBalance"] = (summary["totalBalance"] ?? 0) + (Number(row.total) || 0);
    }
    return {
        company: t.companyName,
        type: entityType,
        asOfDate: asOf,
        bucketDefinitions: bucketDefs.map(({ key, label }) => ({ key, label })),
        count: rows.length,
        rows,
        summary,
    };
}
export function registerAgingTools(server) {
    server.registerTool("compute_customer_aging", {
        title: "Customer aging",
        description: "Computes customer aging breakdown — overdue buckets (Not Yet Due, 1-30, 31-60, 61-90, 90+) with totals. Reads open Cust. Ledger Entries and classifies by due date.",
        inputSchema: {
            filter: z.string().optional().describe("Filter customers (e.g. 'No.=10000..20000')."),
            asOfDate: z.string().optional().describe("Aging as-of date (YYYY-MM-DD). Defaults to today."),
            buckets: z.string().optional().describe("Comma-separated day thresholds (e.g. '30,60,90'). Default: 30,60,90."),
            lcid: z.number().int().optional(),
            format: z.enum(["json", "markdown"]).optional(),
            companyId: z.string().optional(),
        },
    }, async ({ filter, asOfDate, buckets, lcid, format = "json", companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await computeAging(t, "Customer", filter, asOfDate, buckets, lcid);
        if (format === "markdown" && Array.isArray(result.rows)) {
            const rows = result.rows;
            const headers = rows.length ? Object.keys(rows[0]) : [];
            const md = toMarkdownTable(headers, rows.map((r) => headers.map((h) => r[h])));
            return json({ ...result, rows: undefined, markdown: md });
        }
        return json(result);
    });
    server.registerTool("compute_vendor_aging", {
        title: "Vendor aging",
        description: "Computes vendor aging breakdown — overdue buckets (Not Yet Due, 1-30, 31-60, 61-90, 90+) with totals. Reads open Vendor Ledger Entries and classifies by due date.",
        inputSchema: {
            filter: z.string().optional().describe("Filter vendors (e.g. 'No.=10000..20000')."),
            asOfDate: z.string().optional().describe("Aging as-of date (YYYY-MM-DD). Defaults to today."),
            buckets: z.string().optional().describe("Comma-separated day thresholds (e.g. '30,60,90'). Default: 30,60,90."),
            lcid: z.number().int().optional(),
            format: z.enum(["json", "markdown"]).optional(),
            companyId: z.string().optional(),
        },
    }, async ({ filter, asOfDate, buckets, lcid, format = "json", companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await computeAging(t, "Vendor", filter, asOfDate, buckets, lcid);
        if (format === "markdown" && Array.isArray(result.rows)) {
            const rows = result.rows;
            const headers = rows.length ? Object.keys(rows[0]) : [];
            const md = toMarkdownTable(headers, rows.map((r) => headers.map((h) => r[h])));
            return json({ ...result, rows: undefined, markdown: md });
        }
        return json(result);
    });
}
//# sourceMappingURL=aging.js.map