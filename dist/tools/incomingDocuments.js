/**
 * Incoming document tools — create, extract attachments, process.
 */
import { z } from "zod";
import { resolveTarget, bcTask, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerIncomingDocumentTools(server) {
    server.registerTool("create_incoming_document", {
        title: "Create incoming document",
        description: "Creates an Incoming Document in BC from a file. Can attach additional files. " +
            "Accepts content as base64 or plain text (auto-encodes).",
        inputSchema: {
            fileName: z.string().describe("File name with extension (e.g. 'invoice.xml')."),
            content: z.string().describe("File content (base64 or plain text — auto-detects)."),
            description: z.string().optional().describe("Document description."),
            additionalFiles: z.array(z.object({
                fileName: z.string(),
                content: z.string(),
            })).optional().describe("Additional files to attach."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ fileName, content, description, additionalFiles, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        function toBase64(s) {
            try {
                const decoded = Buffer.from(s, "base64").toString("base64");
                if (decoded === s)
                    return s;
            }
            catch { /* not base64 */ }
            return Buffer.from(s, "utf8").toString("base64");
        }
        const data = {
            fileName: String(fileName),
            fileContent: toBase64(content),
        };
        if (description)
            data.description = String(description);
        if (additionalFiles?.length) {
            data.additionalFiles = additionalFiles.map((f) => ({
                fileName: String(f.fileName),
                fileContent: toBase64(f.content),
            }));
        }
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Incoming.Document.Create",
            source: MCP_SOURCE,
            data: JSON.stringify(data),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, ...result });
    });
    server.registerTool("extract_incoming_document_attachments", {
        title: "Extract incoming document attachments",
        description: "Reads an incoming document and returns its attachment metadata (file names, sizes).",
        inputSchema: {
            entryNo: z.number().int().describe("Incoming Document entry number."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ entryNo, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Incoming.Document.Get",
            source: MCP_SOURCE,
            data: JSON.stringify({ entryNo: Number(entryNo) }),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, ...result });
    });
    server.registerTool("process_incoming_document", {
        title: "Process incoming document",
        description: "Processes an incoming document through BC's data exchange pipeline. " +
            "Performs pre-checks (data exchange type, write permissions, status) and then calls Incoming.Document.Process.",
        inputSchema: {
            entryNo: z.number().int().describe("Incoming Document entry number."),
            dataExchangeType: z.string().optional().describe("Data exchange type code (checked before processing)."),
            force: z.boolean().optional().describe("Skip pre-check warnings and process anyway."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ entryNo, dataExchangeType, force = false, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        // Pre-check: get the incoming document
        const getResult = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Incoming.Document.Get",
            source: MCP_SOURCE,
            data: JSON.stringify({ entryNo: Number(entryNo) }),
            ...(lcid != null ? { lcid } : {}),
        });
        const warnings = [];
        const status = getResult.status ?? getResult.Status;
        if (status && String(status).toLowerCase() === "processed" && !force) {
            return json({
                company: t.companyName, entryNo, processed: false,
                message: "Document is already processed. Use force=true to reprocess.",
            });
        }
        if (dataExchangeType) {
            const actualType = getResult.dataExchangeType ?? getResult.DataExchangeDefinitionCode;
            if (actualType && String(actualType) !== String(dataExchangeType)) {
                warnings.push(`Data exchange type mismatch: expected '${dataExchangeType}', found '${actualType}'.`);
                if (!force) {
                    return json({
                        company: t.companyName, entryNo, processed: false, warnings,
                        message: "Data exchange type mismatch. Use force=true to override.",
                    });
                }
            }
        }
        const data = { entryNo: Number(entryNo) };
        if (dataExchangeType)
            data.dataExchangeType = String(dataExchangeType);
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Incoming.Document.Process",
            source: MCP_SOURCE,
            data: JSON.stringify(data),
            ...(lcid != null ? { lcid } : {}),
        });
        const ret = { company: t.companyName, entryNo, processed: true, ...result };
        if (warnings.length)
            ret.warnings = warnings;
        return json(ret);
    });
}
//# sourceMappingURL=incomingDocuments.js.map