import { getAuthContext } from "../auth/context.js";
import { getSelection } from "../session/store.js";
import { resolveTarget, bcTask, json } from "../bc/runtime.js";
const MCP_SOURCE = "Origo-BC Cloud Events MCP";
export function registerWhoAmI(server) {
    server.registerTool("who_am_i", {
        title: "Who am I",
        description: "Returns how you are authenticated (oauth, origo-token, or basic), your home " +
            "tenant, principal, and the current session selection — then calls Help.WhoAmI.Get " +
            "in Business Central to confirm end-to-end connectivity.",
        inputSchema: {},
    }, async () => {
        const ctx = getAuthContext();
        const mcpContext = {
            method: ctx.method,
            homeTenantId: ctx.homeTenantId,
            principal: ctx.principal ?? null,
            environment: ctx.conn.environment,
            selection: getSelection(ctx.sessionId),
        };
        const t = await resolveTarget();
        const bcResult = await bcTask(t.tenantId, t.environment, t.companyId, {
            specversion: "1.0",
            type: "Help.WhoAmI.Get",
            source: MCP_SOURCE,
        });
        return json({ mcpContext, company: t.companyName, ...bcResult });
    });
}
//# sourceMappingURL=whoami.js.map