/**
 * Connection validation and refresh token acquisition.
 *
 * Used by the setup wizard and the standalone `origo-bc-mcp-server verify` command
 * to confirm that a connection's credentials can actually reach BC.
 *
 * For SaaS connections:
 *   - Client-secret flow: acquires a token via client_credentials grant.
 *   - Refresh-token flow: acquires a token via refresh_token grant.
 *     If the refresh token is expired/revoked, triggers an interactive browser
 *     sign-in (Authorization Code + PKCE, loopback redirect) to obtain a new one.
 *
 * For On-prem connections:
 *   - Sends a Basic-auth request to the BC base URL's /api/v2.0/companies endpoint.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
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
// ── Authorization Code + PKCE flow (loopback redirect) ────────────────────────
//
// Replaces the legacy device-code flow. Device code is phishable (an attacker
// can relay a device code to a victim and have them approve the attacker's
// session) and was designed for input-constrained devices, not developer
// workstations. Authorization Code + PKCE with a loopback redirect is the
// Microsoft-recommended flow for native/CLI apps that can open a local browser.
//
// Prerequisite: the app registration must have a "Mobile and desktop
// applications" platform redirect URI of exactly `http://localhost` (Entra
// matches loopback redirect URIs on any port when registered this way).
function base64url(input) {
    return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function authCodeFlow(tenantId, clientId) {
    const scope = `${BC_SCOPE} offline_access`;
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
    const state = base64url(randomBytes(16));
    let redirectUri = "";
    const code = await new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutHandle);
            server.close();
            fn();
        };
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname !== "/callback") {
                res.writeHead(404).end();
                return;
            }
            const returnedState = url.searchParams.get("state");
            const authCode = url.searchParams.get("code");
            const error = url.searchParams.get("error");
            if (error || !authCode || returnedState !== state) {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end("<html><body><h3>Sign-in failed. You can close this window.</h3></body></html>");
                finish(() => rejectPromise(new Error(url.searchParams.get("error_description") ?? error ?? "Invalid or missing authorization code")));
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h3>Signed in — you can close this window.</h3></body></html>");
            finish(() => resolvePromise(authCode));
        });
        const timeoutHandle = setTimeout(() => {
            finish(() => rejectPromise(new Error("Sign-in timed out. Please try again.")));
        }, 5 * 60 * 1000);
        server.on("error", (err) => finish(() => rejectPromise(err)));
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            redirectUri = `http://127.0.0.1:${port}/callback`;
            const authUrl = new URL(`https://${TOKEN_HOST}/${tenantId}/oauth2/v2.0/authorize`);
            authUrl.searchParams.set("client_id", clientId);
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set("response_mode", "query");
            authUrl.searchParams.set("scope", scope);
            authUrl.searchParams.set("state", state);
            authUrl.searchParams.set("code_challenge", codeChallenge);
            authUrl.searchParams.set("code_challenge_method", "S256");
            console.log(`\n  ── Browser Sign-In (Authorization Code + PKCE) ──`);
            console.log("  Opening your browser to complete sign-in...");
            console.log(`  If it doesn't open automatically, visit:\n  ${authUrl.toString()}\n`);
            try {
                const opener = platform() === "win32" ? "start" : platform() === "darwin" ? "open" : "xdg-open";
                spawnSync(opener, [authUrl.toString()], { shell: true, windowsHide: true });
            }
            catch { /* non-fatal */ }
        });
    });
    const tokRes = await fetch(`https://${TOKEN_HOST}/${tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
            scope,
        }),
    });
    const tok = (await tokRes.json());
    if (!tok.refresh_token) {
        throw new Error(`Authorization code exchange failed: ${tok.error_description ?? tok.error}`);
    }
    console.log("  ✓ Authentication successful.\n");
    return tok.refresh_token;
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
        // If refresh token expired/revoked and interactive re-auth is allowed, offer it.
        if (saas.refreshToken && opts?.allowInteractive) {
            const isExpired = msg.includes("AADSTS700082") || // expired
                msg.includes("AADSTS70000") || // revoked/invalid grant
                msg.includes("AADSTS50173") || // fresh credentials needed
                msg.includes("AADSTS65001") || // consent required
                msg.includes("invalid_grant");
            if (isExpired) {
                console.log(`\n  ⚠ Refresh token is invalid or expired: ${msg}`);
                console.log("  Starting browser sign-in to obtain a new token...\n");
                try {
                    const freshToken = await authCodeFlow(saas.tenantId, saas.clientId);
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
    const separator = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}/api/v2.0/companies${separator}tenant=${tenant}`;
    const authHeader = "Basic " + Buffer.from(`${conn.user}:${conn.key}`).toString("base64");
    try {
        const res = await fetch(url, {
            headers: {
                Authorization: authHeader,
                Accept: "application/json",
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