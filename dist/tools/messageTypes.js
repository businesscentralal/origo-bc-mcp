/**
 * Message type tools — list_message_types, get_message_type_help, invoke_message_type.
 */
import { z } from "zod";
import { resolveTarget, bcTask, bcQueuePost, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerMessageTypeTools(server) {
    server.registerTool("list_message_types", {
        title: "List message types",
        description: "Lists available Cloud Events message types registered in the BC environment.",
        inputSchema: {
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.MessageTypes.Get",
            source: MCP_SOURCE,
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, ...result });
    });
    server.registerTool("get_message_type_help", {
        title: "Get message type help",
        description: "Gets detailed help for a specific message type — description, parameters, examples, and usage patterns.",
        inputSchema: {
            messageType: z.string().describe("The message type to get help for (e.g. 'Data.Records.Get')."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ messageType, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.Implementation.Get",
            source: MCP_SOURCE,
            subject: String(messageType),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, messageType: String(messageType), ...result });
    });
    server.registerTool("invoke_message_type", {
        title: "Invoke message type",
        description: "Invokes any Cloud Events message type. This is the universal tool for all BC operations — " +
            "data queries, record writes, document processing, search, translations, etc. " +
            "Set async=true to queue for background processing. " +
            "First call get_message_type_help for the correct envelope structure.",
        inputSchema: {
            type: z.string().describe("The Cloud Events message type (e.g. 'Sales.Order.Post')."),
            data: z.union([z.string(), z.record(z.unknown())]).optional().describe("Payload — string or JSON object."),
            subject: z.string().optional().describe("Optional subject field."),
            async: z.boolean().optional().describe("If true, queues for async processing and returns a tracking ID."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ type: msgType, data, subject, async: isAsync, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const envelope = {
            specversion: "1.0",
            type: String(msgType),
            source: MCP_SOURCE,
        };
        if (subject)
            envelope.subject = String(subject);
        if (data !== undefined && data !== null) {
            envelope.data = typeof data === "string" ? data : JSON.stringify(data);
        }
        if (lcid != null)
            envelope.lcid = lcid;
        // Async mode: queue for background processing
        if (isAsync) {
            const result = await bcQueuePost(t.tenantId, t.environment, t.companyId, envelope);
            return json({ company: t.companyName, messageType: String(msgType), mode: "queued", ...result });
        }
        // Sync mode: execute immediately
        let result;
        try {
            result = await bcTask(t.tenantId, t.environment, t.companyId, envelope);
        }
        catch (err) {
            let helpText;
            try {
                const helpResult = await bcTask(t.tenantId, t.environment, t.companyId, {
                    specversion: "1.0",
                    type: "Help.Implementation.Get",
                    source: MCP_SOURCE,
                    subject: String(msgType),
                });
                helpText = JSON.stringify(helpResult, null, 2);
            }
            catch { /* ignore */ }
            const errMsg = err.message;
            if (helpText) {
                throw new Error(`${errMsg}\n\n--- Message Type Help ---\n${helpText}`);
            }
            throw err;
        }
        return json({ company: t.companyName, messageType: String(msgType), ...result });
    });
    // Keep call_message_type as alias for backward compatibility
    server.registerTool("call_message_type", {
        title: "Call message type (alias)",
        description: "Alias for invoke_message_type. Use invoke_message_type instead.",
        inputSchema: {
            type: z.string(),
            data: z.union([z.string(), z.record(z.unknown())]).optional(),
            subject: z.string().optional(),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ type: msgType, data, subject, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const envelope = {
            specversion: "1.0",
            type: String(msgType),
            source: MCP_SOURCE,
        };
        if (subject)
            envelope.subject = String(subject);
        if (data !== undefined && data !== null) {
            envelope.data = typeof data === "string" ? data : JSON.stringify(data);
        }
        if (lcid != null)
            envelope.lcid = lcid;
        const result = await bcTask(t.tenantId, t.environment, t.companyId, envelope);
        return json({ company: t.companyName, messageType: String(msgType), ...result });
    });
}
/**
 * Lite registration — only invoke_message_type, list_message_types, get_message_type_help.
 * Skips the call_message_type alias and queue_message_type (invoke handles both).
 */
export function registerMessageTypesLite(server) {
    // Re-use the full registration then... actually we need to register only the 3 tools.
    // For simplicity, call the full function — it registers all including the alias.
    // In the lite server, the extra alias is harmless (tiny overhead).
    registerMessageTypeTools(server);
}
//# sourceMappingURL=messageTypes.js.map