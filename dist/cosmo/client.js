/**
 * Cosmo Alpaca backend HTTP client (Bearer auth).
 * Paths aligned with Cosmo Alpaca VS Code ext 1.27 OpenAPI client.
 */
import { getLocalSettings } from "../config/localSettings.js";
const DEFAULT_BACKEND = "https://cosmo-alpaca-enterprise.westeurope.cloudapp.azure.com";
export function getCosmoConfig(overrides) {
    const ls = getLocalSettings();
    const backendUrl = (overrides?.backendUrl ||
        process.env.COSMO_BACKEND_URL ||
        ls.cosmo?.backendUrl ||
        DEFAULT_BACKEND)
        .trim()
        .replace(/\/+$/, "");
    const bearerToken = (overrides?.bearerToken ||
        process.env.COSMO_BEARER_TOKEN ||
        ls.cosmo?.bearerToken ||
        "").trim();
    if (!bearerToken) {
        throw new Error("Cosmo auth missing. Set COSMO_BEARER_TOKEN, or cosmo.bearerToken in local.settings.json. " +
            "Obtain a token from the Cosmo Alpaca VS Code extension session (GitHub or Azure DevOps " +
            "Bearer used by the extension), or an equivalent Alpaca API bearer for your tenant.");
    }
    return { backendUrl, bearerToken };
}
export async function cosmoRequest(method, path, opts) {
    const cfg = getCosmoConfig({ backendUrl: opts?.backendUrl, bearerToken: opts?.bearerToken });
    const pathPart = path.startsWith("/") ? path : `/${path}`;
    const url = `${cfg.backendUrl}${pathPart}`;
    const headers = {
        Authorization: `Bearer ${cfg.bearerToken}`,
        Accept: "application/json",
    };
    if (opts?.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }
    const start = Date.now();
    const res = await fetch(url, {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const durationMs = Date.now() - start;
    const respHeaders = {};
    for (const [k, v] of res.headers.entries())
        respHeaders[k] = v;
    if (opts?.binary) {
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = respHeaders["content-type"] ?? "";
        if (ct.includes("json")) {
            const rawText = buf.toString("utf8");
            let body = rawText;
            try {
                body = JSON.parse(rawText);
            }
            catch {
                /* keep text */
            }
            return { status: res.status, headers: respHeaders, body, rawText, durationMs, url };
        }
        return {
            status: res.status,
            headers: respHeaders,
            body: { bytes: buf.length, base64Preview: buf.subarray(0, 64).toString("base64") },
            rawText: "",
            durationMs,
            url,
        };
    }
    const rawText = await res.text();
    let body = rawText || null;
    if (rawText.trim()) {
        try {
            body = JSON.parse(rawText);
        }
        catch {
            body = rawText;
        }
    }
    return { status: res.status, headers: respHeaders, body, rawText, durationMs, url };
}
/** Derive BC REST/DEV bases from container id + Cosmo public host (Alpaca pattern). */
export function deriveBcEndpoints(containerId, publicHost) {
    const host = (publicHost || DEFAULT_BACKEND).replace(/\/+$/, "");
    const id = containerId.replace(/\/+$/, "");
    return {
        containerId: id,
        restBaseUrl: `${host}/${id}rest`,
        developerBaseUrl: `${host}/${id}dev`,
    };
}
export function cosmoErrorHint(status, body) {
    if (status === 401 || status === 403) {
        return (`Cosmo API HTTP ${status}. Refresh COSMO_BEARER_TOKEN (GitHub or Azure DevOps bearer from ` +
            `Cosmo Alpaca VS Code session). Body: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300)}`);
    }
    if (status === 404) {
        return (`Cosmo API HTTP 404 for this path/host. Confirm cosmo.backendUrl / COSMO_BACKEND_URL matches ` +
            `the backendUrl returned for your org/repo (parent resource), not only the public container host. ` +
            `Body: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300)}`);
    }
    return undefined;
}
//# sourceMappingURL=client.js.map