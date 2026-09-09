import crypto from "node:crypto";
import { config } from "../config.js";
import { runWithAuth } from "./context.js";
import { buildDevConnectionContext } from "./devContext.js";
import { verifyBearer } from "./entra.js";
import { connectionFromOrigoToken } from "./origoToken.js";
import { getLocalSettings, isBasicAuthEnabled } from "../config/localSettings.js";
import { getSelection, setSelection } from "../session/store.js";
function header(req, name) {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
}
function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
/** Dev-only: validate Basic auth, then build context from the local dev connection. */
function buildBasicContext(authz, sessionId, connectionName) {
    const ls = getLocalSettings();
    const ba = ls.basicAuth;
    const decoded = Buffer.from(authz.replace(/^Basic\s+/i, "").trim(), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
    if (!safeEqual(user, ba.username) || !safeEqual(pass, ba.password)) {
        throw new Error("Invalid Basic credentials");
    }
    try {
        return buildDevConnectionContext({
            connectionName,
            principal: user,
            sessionId,
        });
    }
    catch (e) {
        const msg = e.message;
        if (!connectionName && msg.includes("devConnection is missing")) {
            throw new Error("Basic auth is enabled but devConnection is missing in local.settings.json");
        }
        throw e;
    }
}
async function buildContext(req) {
    const sessionId = header(req, "mcp-session-id");
    const authz = header(req, "authorization");
    const origoToken = header(req, "x-origo-token");
    // ?connection=<name> selects a named connection from local.settings.json
    const connectionName = req.query?.connection || undefined;
    // 0) Basic auth (DEV ONLY — disabled when NODE_ENV=production)
    if (authz && /^Basic\s+/i.test(authz) && isBasicAuthEnabled()) {
        return buildBasicContext(authz, sessionId, connectionName);
    }
    // 1) OAuth 2.1 bearer (claude.ai)
    if (authz && /^Bearer\s+/i.test(authz)) {
        const token = authz.replace(/^Bearer\s+/i, "").trim();
        const claims = await verifyBearer(token);
        const tid = String(claims.tid);
        const principal = String(claims.oid ?? claims.sub ?? "");
        return {
            method: "oauth",
            homeTenantId: tid,
            principal,
            claims,
            sessionId,
            conn: {
                tenantId: tid,
                environment: config.defaultEnvironment,
                bearerToken: token,
                bearerClaims: claims,
                clientId: config.bcClientId,
                clientSecret: config.bcClientSecret,
            },
        };
    }
    // 2) x-origo-token (OpenClaw)
    if (origoToken) {
        const conn = connectionFromOrigoToken(origoToken);
        return {
            method: "origo-token",
            homeTenantId: conn.tenantId,
            principal: conn.clientId ?? conn.tenantId,
            sessionId,
            conn,
        };
    }
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
}
export function authMiddleware(req, res, next) {
    buildContext(req)
        .then((ctx) => {
        // Auto-seed session selection from connection config on first request.
        if (ctx.sessionId && ctx.conn.tenantId) {
            const sel = getSelection(ctx.sessionId);
            if (!sel.tenantId && !sel.environment && !sel.companyId) {
                setSelection(ctx.sessionId, {
                    tenantId: ctx.conn.tenantId,
                    environment: ctx.conn.environment,
                    companyId: ctx.conn.companyId,
                    companyName: ctx.conn.companyName,
                });
            }
        }
        runWithAuth(ctx, () => next());
    })
        .catch((err) => {
        const status = err.status ?? 401;
        const challenges = [
            `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`,
        ];
        if (isBasicAuthEnabled())
            challenges.push('Basic realm="origo-bc-mcp-dev"');
        res.setHeader("WWW-Authenticate", challenges);
        res.status(status).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: `Authentication failed: ${err.message}` },
            id: null,
        });
    });
}
//# sourceMappingURL=middleware.js.map