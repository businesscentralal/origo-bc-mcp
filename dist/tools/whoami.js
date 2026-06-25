import { getAuthContext } from "../auth/context.js";
import { getSelection } from "../session/store.js";
export function registerWhoAmI(server) {
    server.registerTool("who_am_i", {
        title: "Who am I",
        description: "Returns how you are authenticated (oauth, origo-token, or basic), your home " +
            "tenant, principal, and the current session selection. Useful as a connectivity check.",
        inputSchema: {},
    }, async () => {
        const ctx = getAuthContext();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        method: ctx.method,
                        homeTenantId: ctx.homeTenantId,
                        principal: ctx.principal ?? null,
                        environment: ctx.conn.environment,
                        selection: getSelection(ctx.sessionId),
                    }, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=whoami.js.map