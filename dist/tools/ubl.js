/**
 * UBL template tools — list_ubl_templates, render_ubl_template.
 * Templates are stored in the Cloud Event Config Store in the setup environment.
 */
import { z } from "zod";
import { json } from "../bc/runtime.js";
import { resolveSetupConn, getSetupAccessToken } from "../bc/setupConn.js";
import { listCompanies } from "../bc/client.js";
const UBL_TEMPLATE_SOURCE = "UBL Templates";
const UBL_TEMPLATE_INDEX_GUID = "DDDD0000-0000-0000-0000-000000000000";
const CS_TABLE = "Cloud Event Config Store";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
const BC_HOST = "api.businesscentral.dynamics.com";
// ── Setup helpers ───────────────────────────────────────────────────────────
async function resolveSetupCompany() {
    const setup = resolveSetupConn();
    if (setup.companyId)
        return { id: setup.companyId, name: setup.companyId };
    const companies = await listCompanies(setup.tenantId, setup.environment);
    if (!companies.length)
        throw new Error("No companies in setup environment.");
    return { id: companies[0].id, name: companies[0].displayName };
}
async function setupBcTask(companyId, envelope) {
    const setup = resolveSetupConn();
    const token = await getSetupAccessToken();
    const taskUrl = `https://${BC_HOST}/v2.0/${setup.tenantId}/${setup.environment}/api/origo/cloudEvent/v1.0/companies(${companyId})/tasks`;
    const res = await fetch(taskUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
    });
    const task = (await res.json());
    if (task.status === "Error")
        throw new Error(String(task.error || JSON.stringify(task)));
    if (task.data) {
        const dataStr = String(task.data);
        if (dataStr.startsWith(`https://${BC_HOST}/`)) {
            const dataRes = await fetch(dataStr, { headers: { Authorization: `Bearer ${token}` } });
            const raw = await dataRes.text();
            try {
                return JSON.parse(raw);
            }
            catch {
                return { result: raw };
            }
        }
    }
    return task;
}
async function getConfig(source, id, companyId) {
    const result = await setupBcTask(companyId, {
        specversion: "1.0",
        type: "Data.Records.Get",
        source: MCP_SOURCE,
        data: JSON.stringify({
            tableName: CS_TABLE,
            tableView: `WHERE(Source=CONST(${source}),Id=CONST(${id}))`,
            skip: 0,
            take: 1,
        }),
    });
    const records = (result.result ?? result.value ?? []);
    if (!records.length)
        return { found: false };
    const blobBase64 = String((records[0].fields ?? {}).Data ?? "");
    const rawString = Buffer.from(blobBase64, "base64").toString("utf8");
    let parsed;
    try {
        parsed = JSON.parse(rawString);
    }
    catch {
        parsed = rawString;
    }
    return { found: true, data: parsed };
}
// ── XML helpers ─────────────────────────────────────────────────────────────
function escapeXml(s) {
    if (s == null)
        return "";
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
function convertLegacyBlocks(templateStr, lineElement) {
    let result = templateStr;
    result = result.replace(/<!-- Repeat TaxSubtotal per VAT rate -->\s*\n(\s*)(<cac:TaxSubtotal>[\s\S]*?<\/cac:TaxSubtotal>)/, (_, indent, block) => `{{#taxSubtotals}}\n${indent}${block}\n${indent}{{/taxSubtotals}}`);
    if (lineElement) {
        const tag = `cac:${lineElement}`;
        const re = new RegExp(`<!-- Repeat ${lineElement} per (?:line )?item -->\\s*\\n(\\s*)(<${tag}>[\\s\\S]*?<\\/${tag}>)`);
        result = result.replace(re, (_, indent, block) => `{{#lines}}\n${indent}${block}\n${indent}{{/lines}}`);
    }
    return result;
}
function renderPlaceholders(text, data) {
    return text.replace(/\{\{(\w+)\|?([^}]*)\}\}/g, (_, name, defaultVal) => {
        const val = data[name];
        return val != null && val !== "" ? String(val) : defaultVal;
    });
}
function injectEmbeddings(xml, embeddings) {
    if (!embeddings.length)
        return xml;
    const embXml = embeddings
        .map((e) => `  <cac:AdditionalDocumentReference>\n` +
        `    <cbc:ID>${escapeXml(e.id)}</cbc:ID>\n` +
        `    <cbc:DocumentDescription>${escapeXml(e.description)}</cbc:DocumentDescription>\n` +
        `    <cac:Attachment>\n` +
        `      <cbc:EmbeddedDocumentBinaryObject mimeCode="${escapeXml(e.mimeCode)}" filename="${escapeXml(e.filename)}">${e.base64Content}</cbc:EmbeddedDocumentBinaryObject>\n` +
        `    </cac:Attachment>\n` +
        `  </cac:AdditionalDocumentReference>`)
        .join("\n");
    if (xml.includes("<cac:PaymentMeans>")) {
        return xml.replace("  <cac:PaymentMeans>", embXml + "\n  <cac:PaymentMeans>");
    }
    return xml.replace(/(\n<\/\w+>)\s*$/, "\n" + embXml + "$1");
}
function renderTemplate(templateStr, data, lineElement) {
    let result = convertLegacyBlocks(templateStr, lineElement);
    result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, blockName, blockBody) => {
        const items = data[blockName];
        if (!Array.isArray(items) || !items.length)
            return "";
        return items
            .map((item) => renderPlaceholders(blockBody, { ...data, ...item }))
            .join("\n");
    });
    result = renderPlaceholders(result, data);
    const embeddingsRaw = data.embeddings;
    if (Array.isArray(embeddingsRaw))
        result = injectEmbeddings(result, embeddingsRaw);
    // Clean empty XML elements
    result = result.replace(/<(cbc:\w+)([^>]*)>\s*<\/\1>\s*\n?/g, "");
    result = result.replace(/<(cac:\w+)([^>]*)>\s*<\/\1>\s*\n?/g, "");
    result = result.replace(/\n{3,}/g, "\n\n");
    return result.trim();
}
// ── Tool registration ───────────────────────────────────────────────────────
export function registerUblTools(server) {
    server.registerTool("list_ubl_templates", {
        title: "List UBL templates",
        description: "Lists available UBL document templates from the central setup environment.",
        inputSchema: {},
    }, async () => {
        const company = await resolveSetupCompany();
        const index = await getConfig(UBL_TEMPLATE_SOURCE, UBL_TEMPLATE_INDEX_GUID, company.id);
        if (!index.found || !index.data) {
            return json({ templates: [], message: "Template index not found in BC storage." });
        }
        const data = index.data;
        const templates = Array.isArray(data.templates) ? data.templates : (Array.isArray(data) ? data : []);
        return json({ company: company.name, templates });
    });
    server.registerTool("render_ubl_template", {
        title: "Render UBL template",
        description: "Renders a UBL XML document from a template and data values. " +
            "Supports Mustache-style placeholders, repeating sections, and embedded attachments.",
        inputSchema: {
            templateGuid: z.string().describe("Template GUID (from list_ubl_templates)."),
            data: z.record(z.unknown()).describe("Template data (field values, lines array, taxSubtotals array)."),
            embeddings: z.array(z.object({
                id: z.string(),
                description: z.string(),
                mimeCode: z.string(),
                filename: z.string(),
                base64Content: z.string(),
            })).optional().describe("Files to embed as AdditionalDocumentReference."),
        },
    }, async ({ templateGuid, data, embeddings }) => {
        if (!templateGuid)
            throw new Error("Parameter 'templateGuid' is required.");
        if (!data || typeof data !== "object")
            throw new Error("Parameter 'data' is required.");
        const company = await resolveSetupCompany();
        const tplRecord = await getConfig(UBL_TEMPLATE_SOURCE, templateGuid, company.id);
        if (!tplRecord.found)
            throw new Error(`Template ${templateGuid} not found.`);
        const tplData = tplRecord.data;
        if (!tplData.template)
            throw new Error(`Template ${templateGuid} has no 'template' field.`);
        const templateStr = String(tplData.template);
        const lineElement = tplData.lineElement ? String(tplData.lineElement) : null;
        const documentType = tplData.documentType ? String(tplData.documentType) : null;
        const mergedData = { ...data };
        if (embeddings?.length)
            mergedData.embeddings = embeddings;
        const xml = renderTemplate(templateStr, mergedData, lineElement);
        const unresolvedMatches = xml.match(/\{\{(\w+)\|?[^}]*\}\}/g) || [];
        const unresolved = [...new Set(unresolvedMatches.map((m) => m.replace(/\{\{(\w+)\|?[^}]*\}\}/, "$1")))];
        const result = {
            company: company.name, templateGuid, documentType, lineElement, xml,
            unresolvedPlaceholders: unresolved,
        };
        if (unresolved.length)
            result.warning = `${unresolved.length} unresolved placeholder(s) remain in the output.`;
        return json(result);
    });
}
//# sourceMappingURL=ubl.js.map