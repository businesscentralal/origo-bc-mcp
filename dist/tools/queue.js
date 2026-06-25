/**
 * Queue tools — queue_get_status, queue_retry, queue_cancel.
 */
import { z } from "zod";
import { resolveTarget, bcTask, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerQueueTools(server) {
    server.registerTool("queue_get_status", {
        title: "Queue: Get status",
        description: "Returns the current status of a queued Cloud Events message. Statuses: Ready, InProgress, Completed, Error.",
        inputSchema: {
            id: z.string().describe("The queue entry ID or tracking GUID."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ id, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Queue.Status",
            source: MCP_SOURCE,
            subject: String(id),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, id: String(id), ...result });
    });
    server.registerTool("queue_retry", {
        title: "Queue: Retry",
        description: "Retries a failed queue entry by resetting its status to Ready.",
        inputSchema: {
            id: z.string().describe("The queue entry ID or tracking GUID."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ id, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Queue.Retry",
            source: MCP_SOURCE,
            subject: String(id),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, id: String(id), ...result });
    });
    server.registerTool("queue_cancel", {
        title: "Queue: Cancel",
        description: "Cancels a queued Cloud Events message if it hasn't started processing yet.",
        inputSchema: {
            id: z.string().describe("The queue entry ID or tracking GUID."),
            lcid: z.number().int().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ id, lcid, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Queue.Cancel",
            source: MCP_SOURCE,
            subject: String(id),
            ...(lcid != null ? { lcid } : {}),
        });
        return json({ company: t.companyName, id: String(id), ...result });
    });
}
//# sourceMappingURL=queue.js.map