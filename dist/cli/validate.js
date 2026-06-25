/**
 * Connection validation and device-code refresh token acquisition.
 *
 * Used by the setup wizard and the standalone `origo-bc-mcp-server verify` command
 * to confirm that a connection's credentials can actually reach BC.
 *
 * For SaaS connections:
 *   - Client-secret flow: acquires a token via client_credentials grant.
 *   - Refresh-token flow: acquires a token via refresh_token grant.
 *     If the refresh token is expired/revoked, triggers device-code flow to obtain a new one.
 *
 * For On-prem connections:
 *   - Sends a Basic-auth request to the BC base URL's /api/v2.0/companies endpoint.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
const BC_API_HOST = "api.businesscentral.dynamics.com";
const TOKEN_HOST = "login.microsoftonline.com";
const BC_SCOPE = "https://api.businesscentral.dynamics.com/.default";
async function acquireToken(conn) {
    const useRefresh = !conn.clientSecret && !!conn.refreshToken;
    const body = useRefresh
        ? new URLSearchParams({
            grant_type: "refresh_token",
            client_id: conn.clientId,
            refresh_token: conn.refreshToken,
            scope: `${BC_SCOPE} offline_access`,
        })
        : new URLSearchParams({
            grant_type: "client_credentials",
            client_id: conn.clientId,
            client_secret: conn.clientSecret,
            scope: BC_SCOPE,
        });
    const res = await fetch(`https://${TOKEN_HOST}/${conn.tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const parsed = (await res.json());
    if (parsed.access_token) {
        return {
            token: parsed.access_token,
            // A new refresh token may be issued alongside the access token.
            newRefreshToken: parsed.refresh_token,
        };
    }
    throw new Error(`${parsed.error ?? "no_token"}: ${parsed.error_description ?? "Unknown error"}`);
}
export async function deviceCodeFlow(tenantId, clientId) {
    const deviceCodeUrl = `https://${TOKEN_HOST}/${tenantId}/oauth2/v2.0/devicecode`;
    const tokenUrl = `https://${TOKEN_HOST}/${tenantId}/oauth2/v2.0/token`;
    const scope = `${BC_SCOPE} offline_access`;
    // Step 1: Request a device code.
    const dcRes = await fetch(deviceCodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, scope }),
    });
    const dc = (await dcRes.json());
    if (!dc.device_code) {
        throw new Error("Device code request failed — check tenantId and clientId.");
    }
    console.log(`\n  ── Device Code Authentication ──`);
    console.log(`  ${dc.message}\n`);
    // Try to open the browser.
    try {
        const opener = platform() === "win32" ? "start" : platform() === "darwin" ? "open" : "xdg-open";
        spawnSync(opener, [dc.verification_uri], { shell: true, windowsHide: true });
    }
    catch { /* non-fatal */ }
    // Step 2: Poll for token.
    let interval = Math.max(dc.interval || 5, 5) * 1000;
    const deadline = Date.now() + dc.expires_in * 1000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        const tokRes = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: dc.device_code,
            }),
        });
        const tok = (await tokRes.json());
        if (tok.refresh_token) {
            console.log("  ✓ Authentication successful.\n");
            return tok.refresh_token;
        }
        if (tok.error === "authorization_pending")
            continue;
        if (tok.error === "slow_down") {
            interval += 5000;
            continue;
        }
        throw new Error(`Device code flow failed: ${tok.error_description ?? tok.error}`);
    }
    throw new Error("Device code flow timed out. Please try again.");
}
// ── Validate a connection end-to-end ─────────────────────────────────────────
export async function validateConnection(conn, opts) {
    // ── On-prem ──
    if ("onPrem" in conn && conn.onPrem) {
        return validateOnPrem(conn);
    }
    // ── SaaS ──
    const saas = conn;
    let token;
    let newRefreshToken;
    try {
        const result = await acquireToken(saas);
        token = result.token;
        newRefreshToken = result.newRefreshToken;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // If refresh token expired/revoked and device code is allowed, offer re-auth.
        if (saas.refreshToken && opts?.allowDeviceCode) {
            const isExpired = msg.includes("AADSTS700082") || // expired
                msg.includes("AADSTS70000") || // revoked/invalid grant
                msg.includes("AADSTS50173") || // fresh credentials needed
                msg.includes("AADSTS65001") || // consent required
                msg.includes("invalid_grant");
            if (isExpired) {
                console.log(`\n  ⚠ Refresh token is invalid or expired: ${msg}`);
                console.log("  Starting device-code flow to obtain a new token...\n");
                try {
                    const freshToken = await deviceCodeFlow(saas.tenantId, saas.clientId);
                    // Retry with new token.
                    saas.refreshToken = freshToken;
                    const retryResult = await acquireToken(saas);
                    token = retryResult.token;
                    newRefreshToken = freshToken;
                }
                catch (dcErr) {
                    return { ok: false, error: dcErr instanceof Error ? dcErr.message : String(dcErr) };
                }
            }
            else {
                return { ok: false, error: msg };
            }
        }
        else {
            return { ok: false, error: msg };
        }
    }
    // Call BC to list companies — proves the token works.
    try {
        const companies = await listBcCompanies(token, saas.tenantId, saas.environment);
        return { ok: true, companies, newRefreshToken };
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), newRefreshToken };
    }
}
// ── BC API calls ─────────────────────────────────────────────────────────────
async function listBcCompanies(token, tenantId, environment) {
    const url = `https://${BC_API_HOST}/v2.0/${tenantId}/${environment}/api/v2.0/companies`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`BC API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json());
    return (data.value ?? []).map((c) => ({ id: c.id, name: c.displayName ?? c.name }));
}
async function validateOnPrem(conn) {
    const baseUrl = conn.baseUrl.replace(/\/+$/, "");
    const tenant = conn.onPremTenant ?? "default";
    const url = `${baseUrl}/api/v2.0/companies`;
    const authHeader = "Basic " + Buffer.from(`${conn.user}:${conn.key}`).toString("base64");
    try {
        const res = await fetch(url, {
            headers: {
                Authorization: authHeader,
                Accept: "application/json",
                ...(tenant !== "default" && { "Tenant-Id": tenant }),
            },
            // On-prem may have self-signed certs; the user can set NODE_TLS_REJECT_UNAUTHORIZED=0.
        });
        if (!res.ok) {
            const body = await res.text();
            return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
        }
        const data = (await res.json());
        const companies = (data.value ?? []).map((c) => ({ id: c.id, name: c.name }));
        return { ok: true, companies };
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
//# sourceMappingURL=validate.js.map