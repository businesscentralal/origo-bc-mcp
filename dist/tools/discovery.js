import { z } from "zod";
import { getAuthContext } from "../auth/context.js";
import { assertTenantAccess, resolveAccessibleTenants } from "../auth/tenantAccess.js";
import { listCompanies } from "../bc/client.js";
import { getSelection, setSelection } from "../session/store.js";
function json(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
export function registerDiscoveryTools(server) {
    // Step 1 — tenants the caller can access (home + guest).
    server.registerTool("bc_list_tenants", {
        title: "List Entra tenants",
        description: "Lists the Entra ID tenants you can access (your home tenant plus any tenants " +
            "where you are a guest) — the same set shown on myaccount.microsoft.com. " +
            "Pick one, then provide an environment name and list companies.",
        inputSchema: {},
    }, async () => {
        const tenants = await resolveAccessibleTenants();
        return json({ tenants });
    });
    // Step 2 — environment is entered manually (no enumeration).
    server.registerTool("bc_list_environments", {
        title: "Environment selection",
        description: "Environments are not enumerated — type the environment name (e.g. 'production' " +
            "or a sandbox name) into bc_select or bc_list_companies. This returns the current " +
            "selection for reference.",
        inputSchema: { tenantId: z.string().optional() },
    }, async ({ tenantId }) => {
        const target = await assertTenantAccess(tenantId);
        const selection = getSelection(getAuthContext().sessionId);
        return json({
            tenantId: target,
            note: "Provide the environment name manually.",
            currentEnvironment: selection.environment ?? null,
        });
    });
    // Step 3 — companies for a tenant + environment.
    server.registerTool("bc_list_companies", {
        title: "List companies",
        description: "Lists the companies in the given tenant + environment so you can pick one. " +
            "Tenant defaults to your selection/home; environment is required if not yet selected.",
        inputSchema: {
            tenantId: z.string().optional(),
            environment: z.string().optional(),
        },
    }, async ({ tenantId, environment }) => {
        const target = await assertTenantAccess(tenantId);
        const ctx = getAuthContext();
        const selection = getSelection(ctx.sessionId);
        // On-prem derives the company from config; environment is not required.
        const env = environment ?? selection.environment ?? (ctx.conn.onPrem ? ctx.conn.environment : undefined);
        if (!env) {
            throw new Error("environment is required — provide it or call bc_select first.");
        }
        const companies = await listCompanies(target, env);
        return json({ tenantId: target, environment: env, companies });
    });
    // Step 4 — persist the selection for this session (saved as GUIDs).
    server.registerTool("bc_select", {
        title: "Select tenant / environment / company",
        description: "Saves the active tenant, environment and company for this session. The company " +
            "is stored as a GUID; if you pass a company name it is resolved to its GUID. " +
            "Subsequent tools use this selection unless overridden per call.",
        inputSchema: {
            tenantId: z.string().optional(),
            environment: z.string().optional(),
            companyId: z.string().optional().describe("Company GUID"),
            companyName: z.string().optional().describe("Company name (resolved to GUID)"),
        },
    }, async ({ tenantId, environment, companyId, companyName }) => {
        const ctx = getAuthContext();
        if (!ctx.sessionId)
            throw new Error("No session id — call initialize first.");
        const target = await assertTenantAccess(tenantId);
        const current = getSelection(ctx.sessionId);
        const env = environment ?? current.environment ?? (ctx.conn.onPrem ? ctx.conn.environment : undefined);
        let resolvedCompanyId = companyId;
        let resolvedCompanyName = companyName;
        if (!resolvedCompanyId && companyName) {
            if (!env)
                throw new Error("environment is required to resolve a company name to a GUID.");
            const companies = await listCompanies(target, env);
            const match = companies.find((c) => c.name.toLowerCase() === companyName.toLowerCase() ||
                c.displayName.toLowerCase() === companyName.toLowerCase());
            if (!match)
                throw new Error(`Company '${companyName}' not found in ${target}/${env}.`);
            resolvedCompanyId = match.id;
            resolvedCompanyName = match.displayName;
        }
        const next = setSelection(ctx.sessionId, {
            tenantId: target,
            environment: env,
            companyId: resolvedCompanyId,
            companyName: resolvedCompanyName,
        });
        return json({ selected: next });
    });
    // Helper — show the current selection.
    server.registerTool("bc_get_selection", {
        title: "Current selection",
        description: "Returns the tenant / environment / company currently selected for this session.",
        inputSchema: {},
    }, async () => json({ selection: getSelection(getAuthContext().sessionId) }));
}
//# sourceMappingURL=discovery.js.map