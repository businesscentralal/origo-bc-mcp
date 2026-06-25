/**
 * Period breakdown tool — compute_period_breakdown.
 * Supports three modes: aging, period-subtraction, period-direct (netChange).
 */
import { z } from "zod";
import { resolveTarget, fetchAllPages, json } from "../bc/runtime.js";
function parseBucket(s) {
    if (typeof s === "number")
        return { value: s, unit: "D" };
    const m = String(s).match(/^(\d+)\s*([DMYWQdmywq]?)$/);
    if (!m)
        throw new Error(`Invalid bucket format: "${s}" — use e.g. "30D", "2W", "1M", "1Q", "1Y".`);
    return { value: parseInt(m[1], 10), unit: (m[2] || "D").toUpperCase() };
}
function estimateDays(b) {
    const { value, unit } = b;
    if (unit === "Y")
        return value * 365.25;
    if (unit === "Q")
        return value * 91.31;
    if (unit === "M")
        return value * 30.44;
    if (unit === "W")
        return value * 7;
    return value;
}
function subtractOffset(dateStr, b) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const { value, unit } = b;
    if (unit === "D")
        d.setUTCDate(d.getUTCDate() - value);
    else if (unit === "W")
        d.setUTCDate(d.getUTCDate() - value * 7);
    else if (unit === "M") {
        const day = d.getUTCDate();
        d.setUTCMonth(d.getUTCMonth() - value);
        if (d.getUTCDate() !== day)
            d.setUTCDate(0);
    }
    else if (unit === "Q") {
        const day = d.getUTCDate();
        d.setUTCMonth(d.getUTCMonth() - value * 3);
        if (d.getUTCDate() !== day)
            d.setUTCDate(0);
    }
    else {
        const day = d.getUTCDate();
        d.setUTCFullYear(d.getUTCFullYear() - value);
        if (d.getUTCDate() !== day)
            d.setUTCDate(0);
    }
    return d.toISOString().slice(0, 10);
}
function addOneDay(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}
function unitLabel(unit, v, isIS) {
    if (isIS) {
        if (unit === "D")
            return v === 1 ? "dagur" : "dagar";
        if (unit === "W")
            return v === 1 ? "vika" : "vikur";
        if (unit === "M")
            return v === 1 ? "mánuður" : "mánuðir";
        if (unit === "Q")
            return v === 1 ? "ársfjórðungur" : "ársfjórðungar";
        return "ár";
    }
    if (unit === "D")
        return v === 1 ? "Day" : "Days";
    if (unit === "W")
        return v === 1 ? "Week" : "Weeks";
    if (unit === "M")
        return v === 1 ? "Month" : "Months";
    if (unit === "Q")
        return v === 1 ? "Quarter" : "Quarters";
    return v === 1 ? "Year" : "Years";
}
function offsetLabel(b, isIS) {
    return `${b.value} ${unitLabel(b.unit, b.value, isIS)}`;
}
function numVal(record, key) {
    if (!record || !key)
        return 0;
    const v = record[key];
    if (v == null)
        return 0;
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
}
export function registerPeriodBreakdownTools(server) {
    server.registerTool("compute_period_breakdown", {
        title: "Period breakdown",
        description: "Computes a period/aging breakdown for any BC table with FlowField balances. " +
            "Three modes: (1) aging — subtracts overdue from total, (2) period-subtraction — " +
            "subtracts cumulative balances at cutoff dates, (3) period-direct (netChange) — " +
            "reads net change per period directly.",
        inputSchema: {
            table: z.string().describe("BC table name (e.g. 'Customer', 'Vendor', 'G/L Account')."),
            balanceFields: z.array(z.number().int()).describe("Field numbers to break down (e.g. [32] for Balance (LCY))."),
            balanceDueField: z.number().int().optional().describe("Field number for overdue balance (enables aging mode)."),
            identifierFields: z.array(z.number().int()).optional().describe("Field numbers for row identification (default [1])."),
            dateFilterField: z.string().optional().describe("Date filter field name (default 'Date Filter')."),
            flowFilters: z.record(z.string()).optional().describe("Additional flow filters (e.g. {\"Currency Filter\": \"USD\"})."),
            asOfDate: z.string().optional().describe("As-of date YYYY-MM-DD (default today)."),
            buckets: z.array(z.string()).optional().describe("Bucket definitions (e.g. ['30D','60D','90D'])."),
            fieldType: z.enum(["balance", "netChange"]).optional().describe("'balance' (default) or 'netChange'."),
            filter: z.string().optional().describe("BC filter expression."),
            includeZeroBalances: z.boolean().optional().describe("Include rows with zero balance."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async (args) => {
        const { table, balanceFields, balanceDueField, identifierFields = [1], dateFilterField = "Date Filter", flowFilters = {}, asOfDate, buckets: bucketsParam, fieldType = "balance", filter, includeZeroBalances = false, lcid = 1033, companyId, } = args;
        if (!table)
            throw new Error("Parameter 'table' is required.");
        if (!balanceFields.length)
            throw new Error("Parameter 'balanceFields' is required.");
        const primaryBalFld = balanceFields[0];
        const multiField = balanceFields.length > 1;
        const agingMode = balanceDueField != null;
        const isNetChange = fieldType === "netChange";
        const effectiveAgingMode = agingMode && !isNetChange;
        const rawBuckets = bucketsParam ?? ["30D", "60D", "90D"];
        const parsedBuckets = rawBuckets.map(parseBucket);
        parsedBuckets.sort((a, b) => estimateDays(a) - estimateDays(b));
        const seen = new Set();
        const uniqueBuckets = parsedBuckets.filter((b) => {
            const k = `${b.value}${b.unit}`;
            if (seen.has(k))
                return false;
            seen.add(k);
            return true;
        });
        if (!uniqueBuckets.length)
            throw new Error("No valid buckets after dedup.");
        const dateRx = /^\d{4}-\d{2}-\d{2}$/;
        const asOf = asOfDate && dateRx.test(String(asOfDate).trim())
            ? String(asOfDate).trim()
            : new Date().toISOString().slice(0, 10);
        const cutoffDates = uniqueBuckets.map((b) => subtractOffset(asOf, b));
        const warnings = [];
        if (isNetChange && agingMode) {
            warnings.push("balanceDueField is ignored when fieldType is 'netChange' — using period-direct mode.");
        }
        if (effectiveAgingMode && balanceDueField === primaryBalFld) {
            warnings.push(`'balanceDueField' (${balanceDueField}) equals 'balanceFields[0]' (${primaryBalFld}) — notYetDue will always be 0.`);
        }
        let baseFilter = (filter || "").trim();
        const dateFltr = dateFilterField;
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`${esc(dateFltr)}\\s*=`, "i").test(baseFilter)) {
            warnings.push(`${dateFltr} was stripped from your filter — it is set automatically per bucket.`);
            baseFilter = baseFilter
                .replace(new RegExp(`,?\\s*${esc(dateFltr)}\\s*=[^),]*`, "gi"), "")
                .replace(/^\s*,\s*/, "").replace(/,\s*$/, "").trim();
        }
        function buildTV(dateVal) {
            const parts = [];
            if (baseFilter) {
                const inner = baseFilter.match(/^WHERE\s*\(([\s\S]*)\)$/i);
                parts.push(inner ? inner[1].trim() : baseFilter);
            }
            parts.push(`${dateFltr}=FILTER(${dateVal})`);
            for (const [n, v] of Object.entries(flowFilters)) {
                if (v)
                    parts.push(`${n}=FILTER(${v})`);
            }
            return `SORTING(No.) WHERE(${parts.join(",")})`;
        }
        const t = await resolveTarget({ companyId });
        const diffFlds = effectiveAgingMode ? [balanceDueField] : balanceFields;
        const idField0 = identifierFields[0];
        const baseNums = [...new Set([...identifierFields, ...balanceFields, ...(effectiveAgingMode ? [balanceDueField] : [])])];
        const cutoffNums = [...new Set([idField0, ...diffFlds])];
        const netChangeEpoch = "1970-01-01";
        const fetches = [
            fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.Records.Get", { tableName: table, tableView: buildTV(isNetChange ? `${netChangeEpoch}..${asOf}` : `..${asOf}`), fieldNumbers: baseNums }, { lcid }),
        ];
        if (isNetChange) {
            for (let i = 0; i < cutoffDates.length; i++) {
                const toDate = i === 0 ? asOf : cutoffDates[i - 1];
                const fromDate = addOneDay(cutoffDates[i]);
                fetches.push(fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.Records.Get", { tableName: table, tableView: buildTV(`${fromDate}..${toDate}`), fieldNumbers: cutoffNums }, { lcid }));
            }
            fetches.push(fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.Records.Get", { tableName: table, tableView: buildTV(`${netChangeEpoch}..${cutoffDates[cutoffDates.length - 1]}`), fieldNumbers: cutoffNums }, { lcid }));
        }
        else {
            for (const cd of cutoffDates) {
                fetches.push(fetchAllPages(t.tenantId, t.environment, t.companyId, "Data.Records.Get", { tableName: table, tableView: buildTV(`..${cd}`), fieldNumbers: cutoffNums }, { lcid }));
            }
        }
        const results = await Promise.all(fetches);
        // Reject partial data — truncated results would produce silently wrong financial totals.
        const truncatedIdx = results.findIndex((r) => r.truncated);
        if (truncatedIdx !== -1) {
            const r = results[truncatedIdx];
            throw new Error(`period_breakdown aborted: dataset too large (fetched ${r.fetched} of ${r.noOfRecords} records). ` +
                `Apply a tighter date range or table filter to reduce result size below 10,000 records per query.`);
        }
        // Flatten record structure
        for (const res of results) {
            res.records = res.records.map((r) => {
                if (r && (r.primaryKey || r.fields))
                    return { ...(r.primaryKey ?? {}), ...(r.fields ?? {}) };
                return r ?? {};
            });
        }
        function resolveKeys(records, fieldNums) {
            if (!records.length)
                return {};
            const keys = Object.keys(records[0]);
            const map = {};
            fieldNums.forEach((fld, i) => { if (i < keys.length)
                map[fld] = keys[i]; });
            return map;
        }
        const baseResult = results[0];
        const baseKeyMap = resolveKeys(baseResult.records, baseNums);
        const cutKeyMap = results.length > 1 ? resolveKeys((results[1] ?? { records: [] }).records, cutoffNums) : {};
        const pkKey = baseKeyMap[idField0];
        const primaryBalKey = baseKeyMap[primaryBalFld];
        const balDueKey = effectiveAgingMode ? baseKeyMap[balanceDueField] : undefined;
        const balKeyOf = (fld) => baseKeyMap[fld];
        const cutKeyOf = (fld) => cutKeyMap[fld];
        const byPK = new Map();
        for (const r of baseResult.records) {
            byPK.set(String(pkKey ? r[pkKey] : Object.values(r)[0]), r);
        }
        const periodCount = isNetChange ? uniqueBuckets.length + 1 : cutoffDates.length;
        const periodMaps = [];
        for (let i = 0; i < periodCount; i++) {
            const m = new Map();
            const pr = results[i + 1];
            if (pr) {
                const recs = pr.records;
                const cpk = recs.length ? Object.keys(recs[0])[0] : undefined;
                for (const r of recs)
                    m.set(String(cpk ? r[cpk] : Object.values(r)[0]), r);
            }
            periodMaps.push(m);
        }
        const isIS = lcid === 1039;
        const bucketDefs = [];
        if (effectiveAgingMode) {
            bucketDefs.push({ key: "notYetDue", label: isIS ? "Ekki gjaldfallið" : "Not Yet Due" });
        }
        for (let i = 0; i < uniqueBuckets.length; i++) {
            const prev = i === 0 ? null : uniqueBuckets[i - 1];
            const curr = uniqueBuckets[i];
            const key = `period_${curr.value}${curr.unit}`;
            let label;
            if (!prev)
                label = `0–${offsetLabel(curr, isIS)}`;
            else if (prev.unit === curr.unit)
                label = `${prev.value}–${curr.value} ${unitLabel(curr.unit, curr.value, isIS)}`;
            else
                label = `${offsetLabel(prev, isIS)}–${offsetLabel(curr, isIS)}`;
            bucketDefs.push({ key, label });
        }
        const lastB = uniqueBuckets[uniqueBuckets.length - 1];
        bucketDefs.push({ key: `period_${lastB.value}${lastB.unit}_plus`, label: `${offsetLabel(lastB, isIS)}+` });
        const rows = [];
        const summary = {};
        for (const bd of bucketDefs)
            summary[bd.key] = multiField ? Object.fromEntries(balanceFields.map((f) => [balKeyOf(f) ?? String(f), 0])) : 0;
        summary.totalBalance = multiField ? Object.fromEntries(balanceFields.map((f) => [balKeyOf(f) ?? String(f), 0])) : 0;
        let summaryCount = 0;
        for (const [pk, base] of byPK) {
            const balance = numVal(base, primaryBalKey);
            if (!includeZeroBalances && Math.abs(balance) < 0.005)
                continue;
            const ident = {};
            for (const fld of identifierFields) {
                const k = baseKeyMap[fld];
                if (k)
                    ident[k] = base[k] ?? "";
            }
            const row = { ...ident };
            let bucketSum;
            if (effectiveAgingMode) {
                const balDue = numVal(base, balDueKey);
                const notYetDue = balance - balDue;
                const overdueBuckets = [];
                let prevAmt = balDue;
                for (let i = 0; i < cutoffDates.length; i++) {
                    const pm = periodMaps[i];
                    const cv = numVal(pm?.get(pk), cutKeyOf(balanceDueField));
                    overdueBuckets.push(prevAmt - cv);
                    prevAmt = cv;
                }
                overdueBuckets.push(prevAmt);
                row.balance = balance;
                row[bucketDefs[0].key] = Math.round(notYetDue * 100) / 100;
                for (let i = 0; i < overdueBuckets.length; i++) {
                    const bd = bucketDefs[i + 1];
                    if (bd)
                        row[bd.key] = Math.round(overdueBuckets[i] * 100) / 100;
                }
                bucketSum = notYetDue + overdueBuckets.reduce((s, v) => s + v, 0);
            }
            else if (isNetChange) {
                const amtsByFld = {};
                for (const fld of balanceFields) {
                    const ck = cutKeyOf(fld);
                    amtsByFld[fld] = [];
                    for (let i = 0; i < uniqueBuckets.length + 1; i++) {
                        const pm = periodMaps[i];
                        amtsByFld[fld].push(numVal(pm?.get(pk), ck));
                    }
                }
                if (multiField) {
                    const balObj = {};
                    for (const f of balanceFields)
                        balObj[balKeyOf(f) ?? String(f)] = numVal(base, balKeyOf(f));
                    row.balance = balObj;
                    for (let i = 0; i < bucketDefs.length; i++) {
                        const pObj = {};
                        const fldAmts = amtsByFld;
                        for (const f of balanceFields)
                            pObj[balKeyOf(f) ?? String(f)] = Math.round((fldAmts[f]?.[i] ?? 0) * 100) / 100;
                        row[bucketDefs[i].key] = pObj;
                    }
                }
                else {
                    const amounts = amtsByFld[primaryBalFld] ?? [];
                    row.balance = balance;
                    for (let i = 0; i < amounts.length; i++) {
                        row[bucketDefs[i].key] = Math.round(amounts[i] * 100) / 100;
                    }
                }
                bucketSum = (amtsByFld[primaryBalFld] ?? []).reduce((s, v) => s + v, 0);
            }
            else {
                // period-subtraction mode
                const amtsByFld = {};
                for (const fld of balanceFields) {
                    const bal = numVal(base, balKeyOf(fld));
                    const amounts = [];
                    let prevAmt = bal;
                    for (let i = 0; i < cutoffDates.length; i++) {
                        const pm = periodMaps[i];
                        const cv = numVal(pm?.get(pk), cutKeyOf(fld));
                        amounts.push(prevAmt - cv);
                        prevAmt = cv;
                    }
                    amounts.push(prevAmt);
                    amtsByFld[fld] = amounts;
                }
                if (multiField) {
                    const balObj = {};
                    for (const f of balanceFields)
                        balObj[balKeyOf(f) ?? String(f)] = numVal(base, balKeyOf(f));
                    row.balance = balObj;
                    for (let i = 0; i < bucketDefs.length; i++) {
                        const pObj = {};
                        for (const f of balanceFields)
                            pObj[balKeyOf(f) ?? String(f)] = Math.round((amtsByFld[f]?.[i] ?? 0) * 100) / 100;
                        row[bucketDefs[i].key] = pObj;
                    }
                }
                else {
                    const amounts = amtsByFld[primaryBalFld] ?? [];
                    row.balance = balance;
                    for (let i = 0; i < amounts.length; i++) {
                        row[bucketDefs[i].key] = Math.round(amounts[i] * 100) / 100;
                    }
                }
                bucketSum = (amtsByFld[primaryBalFld] ?? []).reduce((s, v) => s + v, 0);
            }
            if (Math.abs(bucketSum - balance) > 0.005) {
                row._warning = `Bucket sum (${bucketSum.toFixed(2)}) differs from balance (${balance.toFixed(2)})`;
                warnings.push(`${pk}: bucket sum mismatch by ${(bucketSum - balance).toFixed(2)}`);
            }
            rows.push(row);
            if (multiField) {
                for (const f of balanceFields) {
                    const bk = balKeyOf(f) ?? String(f);
                    const totalBal = summary.totalBalance;
                    totalBal[bk] = Math.round(((totalBal[bk] || 0) + numVal(base, bk)) * 100) / 100;
                    for (const bd of bucketDefs) {
                        const rv = row[bd.key];
                        const v = rv && typeof rv === "object" ? (rv[bk] || 0) : 0;
                        const summBucket = summary[bd.key];
                        summBucket[bk] = Math.round(((summBucket[bk] || 0) + v) * 100) / 100;
                    }
                }
            }
            else {
                summary.totalBalance =
                    (summary.totalBalance || 0) + balance;
                for (const bd of bucketDefs) {
                    summary[bd.key] =
                        (summary[bd.key] || 0) + (row[bd.key] || 0);
                }
            }
            summaryCount += 1;
        }
        if (!multiField) {
            for (const bd of bucketDefs) {
                summary[bd.key] = Math.round((summary[bd.key] || 0) * 100) / 100;
            }
            summary.totalBalance =
                Math.round((summary.totalBalance || 0) * 100) / 100;
        }
        const response = {
            company: t.companyName, table, mode: effectiveAgingMode ? "aging" : isNetChange ? "period-direct" : "period-subtraction",
            fieldType: isNetChange ? "netChange" : "balance", asOfDate: asOf,
            bucketDefinitions: bucketDefs, rows, summary: { ...summary, count: summaryCount },
            recordsFetched: baseResult.fetched, parallelCalls: fetches.length,
        };
        if (warnings.length)
            response.warnings = warnings;
        return json(response);
    });
}
//# sourceMappingURL=periodBreakdown.js.map