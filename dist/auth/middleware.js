import crypto from "node:crypto";
import { config } from "../config.js";
import { runWithAuth } from "./context.js";
import { verifyBearer } from "./entra.js";
import { connectionFromOrigoToken } from "./origoToken.js";
import { getLocalSettings, getConnection, isBasicAuthEnabled } from "../config/localSettings.js";
function header(req, name) {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
}
function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
/** Dev-only: build a context from Basic auth + the local dev connection. */
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
    const dc = getConnection(connectionName);
    if (!dc) {
        const msg = connectionName
            ? `Connection "${connectionName}" not found in local.settings.json`
            : "Basic auth is enabled but devConnection is missing in local.settings.json";
        throw new Error(msg);
    }
    // On-prem dev connection (Basic auth against a BC REST base URL).
    if (dc.onPrem || dc.baseUrl) {
        if (!dc.baseUrl || !dc.user || !dc.key) {
            throw new Error("On-prem devConnection requires baseUrl, user and key in local.settings.json");
        }
        const onPremTenant = dc.onPremTenant ?? "default";
        return {
            method: "basic",
            homeTenantId: onPremTenant,
            principal: user,
            sessionId,
            conn: {
                tenantId: onPremTenant,
                environment: dc.environment ?? "onprem",
                onPrem: true,
                baseUrl: dc.baseUrl,
                onPremTenant,
                user: dc.user,
                key: dc.key,
                companyId: dc.companyId,
                companyName: dc.companyName,
            },
        };
    }
    // SaaS dev connection (Entra: refresh token or client credentials).
    if (!dc.tenantId || !dc.clientId) {
        throw new Error("SaaS devConnection requires tenantId + clientId in local.settings.json");
    }
    return {
        method: "basic",
        homeTenantId: dc.tenantId,
        principal: user,
        sessionId,
        conn: {
            tenantId: dc.tenantId,
            environment: dc.environment ?? config.defaultEnvironment,
            clientId: dc.clientId,
            clientSecret: dc.clientSecret,
            refreshToken: dc.refreshToken,
            companyId: dc.companyId,
            companyName: dc.companyName,
        },
    };
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