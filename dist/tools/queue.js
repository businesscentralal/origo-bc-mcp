/**
 * Queue tools — queue_get_status, queue_retry, queue_cancel.
 *
 * All three use direct BC REST endpoints (/queues/<id>/Microsoft.NAV.*)
 * rather than Cloud Events message types — BC has no Queue.Status/Retry/Cancel
 * message type handlers; the queue is a direct REST API.
 */
import { z } from "zod";
import { resolveTarget, bcQueueStatus, bcQueueRetry, bcQueueCancel, json } from "../bc/runtime.js";
export function registerQueueTools(server) {
    server.registerTool("queue_get_status", {
        title: "Queue: Get status",
        description: "Polls the status of a background queue entry (POST /queues/<id>/Microsoft.NAV.GetStatus). " +
            "Call this repeatedly after queue_message_type — wait 3-5 seconds between polls. " +
            "Status values: " +
            "'running' (still processing, keep polling), " +
            "'bc_success' (BC completed successfully — read bcResponse for result details), " +
            "'bc_error' (BC completed but returned an error — read bcResponse.error), " +
            "'deleted' (entry no longer exists), " +
            "'error' (HTTP-level failure). " +
            "When status is 'bc_success' or 'bc_error', the 'bcResponse' field contains the full decoded BC response " +
            "(JSON object, CSV/markdown text, or { datacontenttype, dataBase64 } for binary payloads like PDFs).",
        inputSchema: {
            id: z.string().describe("Queue entry ID returned by queue_message_type."),
            companyId: z.string().optional(),
        },
    }, async ({ id, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcQueueStatus(t.tenantId, t.environment, t.companyId, String(id));
        return json({ company: t.companyName, queueId: String(id), ...result });
    });
    server.registerTool("queue_retry", {
        title: "Queue: Retry",
        description: "Retries a failed or cancelled queue entry (POST /queues/<id>/Microsoft.NAV.RetryTask). " +
            "Use after queue_get_status returns 'bc_error' or 'deleted' to re-submit without creating a new entry. " +
            "Status values in response: 'retried' (retry initiated — resume polling with queue_get_status), " +
            "'none' (nothing to retry), 'error' (retry call failed).",
        inputSchema: {
            id: z.string().describe("Queue entry ID to retry."),
            companyId: z.string().optional(),
        },
    }, async ({ id, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcQueueRetry(t.tenantId, t.environment, t.companyId, String(id));
        return json({ company: t.companyName, queueId: String(id), ...result });
    });
    server.registerTool("queue_cancel", {
        title: "Queue: Cancel",
        description: "Cancels a running or pending queue entry (POST /queues/<id>/Microsoft.NAV.CancelTask). " +
            "Use when you want to abort a background operation before it completes. " +
            "Status values in response: 'cancelled' (successfully cancelled), " +
            "'none' (nothing to cancel or already finished), 'error' (cancel call failed).",
        inputSchema: {
            id: z.string().describe("Queue entry ID to cancel."),
            companyId: z.string().optional(),
        },
    }, async ({ id, companyId }) => {
        const t = await resolveTarget({ companyId });
        const result = await bcQueueCancel(t.tenantId, t.environment, t.companyId, String(id));
        return json({ company: t.companyName, queueId: String(id), ...result });
    });
}
//# sourceMappingURL=queue.js.map