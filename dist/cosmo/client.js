/**
 * Cosmo Alpaca backend HTTP client (Bearer auth).
 * Paths aligned with Cosmo Alpaca VS Code ext 1.27 OpenAPI client.
 */
import { getLocalSettings } from "../config/localSettings.js";
import { resolveSecret } from "../config/resolveSecret.js";
/** Public container host (REST/DEV path prefix). Not the Alpaca API base. */
const DEFAULT_PUBLIC_HOST = "https://cosmo-alpaca-enterprise.westeurope.cloudapp.azure.com";
/** Alpaca OpenAPI basePath (VS Code ext 1.27). Bare host alone 404s on /Container/*. */
const DEFAULT_BACKEND = `${DEFAULT_PUBLIC_HOST}/api/alpaca/release`;
export function getCosmoConfig(overrides) {
    const ls = getLocalSettings();
    const backendUrl = (overrides?.backendUrl ||
        process.env.COSMO_BACKEND_URL ||
        ls.cosmo?.backendUrl ||
        DEFAULT_BACKEND)
        .trim()
        .replace(/\/+$/, "");
    const rawBearer = overrides?.bearerToken ||
        process.env.COSMO_BEARER_TOKEN ||
        ls.cosmo?.bearerToken ||
        "";
    // Support env:/aes:/plain: prefixes when token comes from settings or overrides.
    const bearerToken = (resolveSecret(rawBearer) ?? rawBearer).trim();
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
    const host = (publicHost || DEFAULT_PUBLIC_HOST).replace(/\/+$/, "");
    const id = containerId.replace(/\/+$/, "");
    return {
        containerId: id,
        restBaseUrl: `${host}/${id}rest`,
        developerBaseUrl: `${host}/${id}dev`,
    };
}
export function cosmoErrorHint(status, body) {
    const bodyPreview = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300);
    if (status === 401 || status === 403) {
        return (`Cosmo API HTTP ${status}. Refresh COSMO_BEARER_TOKEN (GitHub or Azure DevOps bearer from ` +
            `Cosmo Alpaca VS Code session). Body: ${bodyPreview}`);
    }
    if (status === 404) {
        const defaultApiBase = `${DEFAULT_PUBLIC_HOST}/api/alpaca/release`;
        return (`Cosmo API HTTP 404 for this path/host. Default backend is ${defaultApiBase} ` +
            `(Alpaca release basePath). A bare public host without /api/alpaca/release yields nginx 404 ` +
            `on /Container/*. Prefer parent org/repo backendUrl from Cosmo when it differs. ` +
            `Body: ${bodyPreview}`);
    }
    return undefined;
}
export const REDACTED = "***REDACTED***";
/**
 * Names Cosmo uses for credentials: container env vars (`password=…`, `licenseFile=…`),
 * create/update bodies (`password`) and SSH info (`privateKey`). Matched case-insensitively
 * against the whole name, after dropping `_`, `-` and `.`.
 */
const SECRET_NAME_RE = /(password|passwd|pwd|secret|privatekey|token|apikey|accesskey|connectionstring|licensefile|sas)$/i;
export function isSecretName(name) {
    return SECRET_NAME_RE.test(name.replace(/[_\-.]/g, ""));
}
/** `NAME=value` env strings (Cosmo `envs` arrays) with a secret NAME. */
function redactEnvString(value) {
    const eq = value.indexOf("=");
    if (eq <= 0)
        return value;
    return isSecretName(value.slice(0, eq)) ? `${value.slice(0, eq + 1)}${REDACTED}` : value;
}
/**
 * Deep copy of a Cosmo response with every credential replaced by REDACTED, so tool results
 * never hand a container password, license SAS URL or SSH private key to the model. Covers
 * secret-named keys, `NAME=value` strings and `{ name, value }` env pairs.
 */
export function redactCosmoSecrets(value) {
    const walk = (v) => {
        if (typeof v === "string")
            return redactEnvString(v);
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === "object") {
            const obj = v;
            const out = {};
            const pairName = typeof obj.name === "string" ? obj.name : undefined;
            for (const [k, child] of Object.entries(obj)) {
                if (child !== null && child !== undefined && child !== "" && typeof child !== "object" && isSecretName(k)) {
                    out[k] = REDACTED;
                }
                else if (k === "value" && pairName && isSecretName(pairName) && typeof child === "string") {
                    out[k] = REDACTED;
                }
                else {
                    out[k] = walk(child);
                }
            }
            return out;
        }
        return v;
    };
    return walk(value);
}
/** Same rule for raw response text (error paths echo it): JSON pairs and NAME=value pairs. */
export function redactCosmoText(text) {
    return text
        .replace(/"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (m, name, sep) => isSecretName(name) ? `"${name}"${sep}"${REDACTED}"` : m)
        .replace(/([A-Za-z][A-Za-z0-9_.\-]*)=([^\s,;&"'}\]]+)/g, (m, name) => isSecretName(name) ? `${name}=${REDACTED}` : m);
}
//# sourceMappingURL=client.js.map