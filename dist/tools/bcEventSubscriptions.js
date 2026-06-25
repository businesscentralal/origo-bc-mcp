/**
 * BC External Business Event Subscription tools.
 * Uses the BC Runtime REST API (not Cloud Events tasks).
 */
import { z } from "zod";
import { resolveTarget, json } from "../bc/runtime.js";
import { getBcAccessToken, listCompanies } from "../bc/client.js";
const BC_HOST = "api.businesscentral.dynamics.com";
// ── HTTP helpers ────────────────────────────────────────────────────────────
async function bcApiCall(tenantId, environment, path, method, body) {
    const token = await getBcAccessToken(tenantId);
    const url = `https://${BC_HOST}${path}`;
    const headers = { Authorization: `Bearer ${token}` };
    if (body)
        headers["Content-Type"] = "application/json";
    if (method === "PATCH" || method === "DELETE")
        headers["If-Match"] = "*";
    const res = await fetch(url, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status >= 400) {
        const text = await res.text();
        throw new Error(`BC API HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0")
        return {};
    const text = await res.text();
    return text ? JSON.parse(text) : {};
}
function defBase(tenantId, environment) {
    return `/v2.0/${tenantId}/${environment}/api/microsoft/runtime/v1.0/externalbusinesseventdefinitions`;
}
function subBase(tenantId, environment) {
    return `/v2.0/${tenantId}/${environment}/api/microsoft/runtime/v1.0/externaleventsubscriptions`;
}
// ── Registration ────────────────────────────────────────────────────────────
export function registerBcEventSubscriptionTools(server) {
    server.registerTool("list_bc_business_event_definitions", {
        title: "List BC business event definitions",
        description: "Lists all [ExternalBusinessEvent] definitions registered on the BC environment. " +
            "Use this to discover event names and appIds before creating a subscription.",
        inputSchema: {
            filter: z.string().optional().describe("Text filter (matches name, displayName, description, category, appName)."),
            companyId: z.string().optional(),
        },
    }, async ({ filter, companyId }) => {
        const t = await resolveTarget({ companyId });
        const data = await bcApiCall(t.tenantId, t.environment, defBase(t.tenantId, t.environment), "GET");
        let items = (data.value ?? []);
        if (filter) {
            const f = String(filter).toLowerCase();
            items = items.filter((d) => ["name", "displayName", "description", "category", "appName"].some((k) => String(d[k] || "").toLowerCase().includes(f)));
        }
        return json({
            environment: t.environment,
            count: items.length,
            definitions: items.map((d) => ({
                name: d.name, displayName: d.displayName, description: d.description,
                category: d.category, appId: d.appId, appName: d.appName,
                appVersion: d.appVersion, appPublisher: d.appPublisher, payload: d.payload,
            })),
        });
    });
    server.registerTool("list_bc_business_event_subscriptions", {
        title: "List BC event subscriptions",
        description: "Lists all active External Business Event subscriptions on the BC environment.",
        inputSchema: {
            companyId: z.string().optional(),
        },
    }, async ({ companyId }) => {
        const t = await resolveTarget({ companyId });
        const data = await bcApiCall(t.tenantId, t.environment, subBase(t.tenantId, t.environment), "GET");
        const items = (data.value ?? []);
        return json({
            environment: t.environment,
            tenantId: t.tenantId,
            count: items.length,
            subscriptions: items.map((s) => ({
                id: s.id || s.subscriptionId,
                companyId: s.companyId,
                companyName: s.companyName,
                eventName: s.eventName,
                appId: s.appId,
                notificationUrl: s.notificationUrl,
                clientStateMask: s.clientState ? `${String(s.clientState).slice(0, 4)}****` : null,
            })),
        });
    });
    server.registerTool("create_bc_business_event_subscription", {
        title: "Create BC event subscription",
        description: "Registers a new External Business Event subscription. " +
            "BC will POST notifications to the notificationUrl when the event fires.",
        inputSchema: {
            notificationUrl: z.string().describe("Webhook URL that receives event notifications."),
            eventName: z.string().describe("Event name from list_bc_business_event_definitions."),
            appId: z.string().describe("GUID of the BC extension that defines the event."),
            clientState: z.string().optional().describe("Shared secret echoed back on notifications."),
            eventVersion: z.string().optional().describe("Event version."),
            companyId: z.string().optional(),
        },
    }, async ({ notificationUrl, eventName, appId, clientState, eventVersion, companyId }) => {
        const t = await resolveTarget({ companyId });
        // Resolve company for the subscription body
        const companies = await listCompanies(t.tenantId, t.environment);
        const company = companyId
            ? companies.find((c) => c.id === companyId) ?? { id: companyId, displayName: companyId }
            : companies[0];
        if (!company)
            throw new Error("No company found.");
        const body = {
            companyName: company.displayName ?? company.id,
            companyId: company.id,
            eventName: String(eventName),
            appId: String(appId),
            notificationUrl: String(notificationUrl),
        };
        if (eventVersion)
            body.eventVersion = String(eventVersion);
        const effectiveClientState = clientState ?? process.env.BC_EVENTS_CLIENT_STATE;
        if (effectiveClientState)
            body.clientState = effectiveClientState;
        const result = await bcApiCall(t.tenantId, t.environment, subBase(t.tenantId, t.environment), "POST", body);
        return json({
            company: company.displayName, environment: t.environment,
            eventName, appId, notificationUrl, eventVersion: eventVersion ?? null,
            result,
        });
    });
    server.registerTool("renew_bc_business_event_subscription", {
        title: "Renew BC event subscription",
        description: "Updates (PATCH) an existing External Business Event subscription.",
        inputSchema: {
            subscriptionId: z.string().describe("Subscription ID to update."),
            notificationUrl: z.string().describe("New webhook URL."),
            companyId: z.string().optional(),
        },
    }, async ({ subscriptionId, notificationUrl, companyId }) => {
        const t = await resolveTarget({ companyId });
        const path = `${subBase(t.tenantId, t.environment)}(${subscriptionId})`;
        const result = await bcApiCall(t.tenantId, t.environment, path, "PATCH", { notificationUrl: String(notificationUrl) });
        return json({
            environment: t.environment,
            subscriptionId: (result.id || result.subscriptionId || subscriptionId),
            notificationUrl: (result.notificationUrl || notificationUrl),
            updated: true,
        });
    });
    server.registerTool("delete_bc_business_event_subscription", {
        title: "Delete BC event subscription",
        description: "Removes a BC External Business Event subscription. BC will stop sending notifications immediately.",
        inputSchema: {
            subscriptionId: z.string().describe("Subscription ID to delete."),
            companyId: z.string().optional(),
        },
    }, async ({ subscriptionId, companyId }) => {
        const t = await resolveTarget({ companyId });
        const path = `${subBase(t.tenantId, t.environment)}(${subscriptionId})`;
        await bcApiCall(t.tenantId, t.environment, path, "DELETE");
        return json({ environment: t.environment, subscriptionId, deleted: true });
    });
}
//# sourceMappingURL=bcEventSubscriptions.js.map