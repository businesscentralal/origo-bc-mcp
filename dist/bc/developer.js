/**
 * Business Central Developer Services helpers.
 * Dev endpoints live under {developerBase}/dev/... (Alpaca: …/{id}dev).
 * REST Automation API uses the normal REST base (…/{id}rest) for uninstall/unpublish.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config.js";
import { getAuthContext } from "../auth/context.js";
import { getBcAccessToken, onPremAuthHeader } from "./client.js";
const BC_HOST = config.bcApiHost;
/**
 * Resolves the Developer Services base URL (without trailing slash).
 * - Prefer explicit `developerBaseUrl`.
 * - Else if on-prem `baseUrl` ends with `rest` (case-insensitive), replace with `dev`
 *   (e.g. …/f0a4d51d4d47rest → …/f0a4d51d4d47dev).
 * - Else for SaaS: https://{bcApiHost}/v2.0/{tenantId}/{environment}
 */
export function resolveDeveloperBaseUrl(conn) {
    if (conn.developerBaseUrl?.trim()) {
        return conn.developerBaseUrl.trim().replace(/\/+$/, "");
    }
    if (conn.onPrem && conn.baseUrl) {
        const base = conn.baseUrl.trim().replace(/\/+$/, "");
        // Match trailing "rest" as a path suffix / final segment ending (Alpaca concatenates id+rest).
        if (/rest$/i.test(base)) {
            return base.replace(/rest$/i, "dev");
        }
        throw new Error("Cannot derive developerBaseUrl from on-prem baseUrl (does not end with 'rest'). " +
            "Set developerBaseUrl explicitly on the connection (e.g. …/f0a4d51d4d47dev).");
    }
    if (!conn.tenantId || !conn.environment) {
        throw new Error("SaaS developer base requires tenantId + environment, or set developerBaseUrl explicitly.");
    }
    return `https://${BC_HOST}/v2.0/${conn.tenantId}/${conn.environment}`;
}
/** REST base used by Automation API (on-prem baseUrl, or SaaS API root). */
export function resolveRestBaseUrl(conn, tenantId, environment) {
    if (conn.onPrem) {
        if (!conn.baseUrl)
            throw new Error("On-prem connection missing baseUrl.");
        const base = conn.baseUrl.trim().replace(/\/+$/, "");
        const tenant = conn.onPremTenant ?? "default";
        return {
            baseUrl: base,
            querySuffix: `?tenant=${encodeURIComponent(tenant)}`,
        };
    }
    return {
        baseUrl: `https://${BC_HOST}/v2.0/${tenantId}/${environment}`,
        querySuffix: "",
    };
}
async function authHeader(conn, tenantId) {
    if (conn.onPrem)
        return onPremAuthHeader(conn);
    return `Bearer ${await getBcAccessToken(tenantId)}`;
}
function headersToObject(res) {
    const out = {};
    for (const [k, v] of res.headers.entries())
        out[k] = v;
    return out;
}
function parseBody(raw) {
    if (!raw.trim())
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
/** Clear guidance when Automation API rejects auth. */
export function automationAuthError(status, body) {
    if (status === 401 || status === 403) {
        return (`Automation API returned HTTP ${status} (forbidden/unauthorized). ` +
            `Ensure the connection user has Automation API permission sets. ` +
            `Fallback on Alpaca/containers: SSH Uninstall-NavApp / Unpublish-NavApp ` +
            `(Cosmo VS Code tools handle container lifecycle — not app uninstall). ` +
            `Details: ${typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body)?.slice(0, 400)}`);
    }
    return undefined;
}
export async function bcDevRequest(method, pathAndQuery, opts) {
    const ctx = getAuthContext();
    const conn = ctx.conn;
    const devBase = resolveDeveloperBaseUrl(conn);
    const url = `${devBase}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
    const auth = await authHeader(conn, conn.tenantId);
    const headers = {
        Authorization: auth,
        ...(opts?.accept ? { Accept: opts.accept } : {}),
        ...opts?.headers,
    };
    const start = Date.now();
    const res = await fetch(url, {
        method,
        headers,
        body: opts?.body ?? undefined,
    });
    const durationMs = Date.now() - start;
    const respHeaders = headersToObject(res);
    if (opts?.saveToPath) {
        const buf = Buffer.from(await res.arrayBuffer());
        mkdirSync(dirname(opts.saveToPath), { recursive: true });
        writeFileSync(opts.saveToPath, buf);
        return {
            status: res.status,
            headers: respHeaders,
            body: null,
            rawText: "",
            durationMs,
            savedPath: opts.saveToPath,
            savedBytes: buf.length,
        };
    }
    const rawText = await res.text();
    return {
        status: res.status,
        headers: respHeaders,
        body: parseBody(rawText),
        rawText,
        durationMs,
    };
}
export async function bcAutomationRequest(tenantId, environment, method, relativePath, opts) {
    const ctx = getAuthContext();
    const conn = ctx.conn;
    const { baseUrl, querySuffix } = resolveRestBaseUrl(conn, tenantId, environment);
    const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
    let url = `${baseUrl}${path}`;
    if (querySuffix) {
        url += url.includes("?") ? querySuffix.replace("?", "&") : querySuffix;
    }
    const auth = await authHeader(conn, tenantId);
    const headers = {
        Authorization: auth,
        Accept: "application/json",
        ...opts?.headers,
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
    const rawText = await res.text();
    return {
        status: res.status,
        headers: headersToObject(res),
        body: parseBody(rawText),
        rawText,
        durationMs,
    };
}
function versionTextOf(ext) {
    return [
        ext.versionMajor ?? 0,
        ext.versionMinor ?? 0,
        ext.versionBuild ?? 0,
        ext.versionRevision ?? 0,
    ].join(".");
}
export async function findExtensions(tenantId, environment, companyId, filter) {
    const path = `/api/microsoft/automation/v2.0/companies(${companyId})/extensions`;
    const res = await bcAutomationRequest(tenantId, environment, "GET", path);
    if (res.status === 401 || res.status === 403) {
        throw new Error(automationAuthError(res.status, res.body));
    }
    if (res.status >= 400) {
        throw new Error(`Failed to list extensions (HTTP ${res.status}): ${res.rawText.slice(0, 400)}`);
    }
    const value = res.body?.value ?? [];
    const mapped = value.map((e) => ({
        packageId: String(e.packageId ?? e.id ?? ""),
        id: e.id !== undefined ? String(e.id) : undefined,
        displayName: e.displayName !== undefined ? String(e.displayName) : undefined,
        publisher: e.publisher !== undefined ? String(e.publisher) : undefined,
        versionMajor: Number(e.versionMajor ?? 0),
        versionMinor: Number(e.versionMinor ?? 0),
        versionBuild: Number(e.versionBuild ?? 0),
        versionRevision: Number(e.versionRevision ?? 0),
        isInstalled: Boolean(e.isInstalled),
        publishedAs: e.publishedAs !== undefined ? String(e.publishedAs) : undefined,
    }));
    return mapped.filter((e) => {
        if (filter.appId && e.id?.toLowerCase() !== filter.appId.toLowerCase() &&
            e.packageId.toLowerCase() !== filter.appId.toLowerCase()) {
            return false;
        }
        if (filter.publisher && e.publisher?.toLowerCase() !== filter.publisher.toLowerCase()) {
            return false;
        }
        if (filter.name && e.displayName?.toLowerCase() !== filter.name.toLowerCase()) {
            return false;
        }
        if (filter.versionText && versionTextOf(e) !== filter.versionText) {
            return false;
        }
        return true;
    });
}
export async function automationBoundAction(tenantId, environment, companyId, packageId, action) {
    const path = `/api/microsoft/automation/v2.0/companies(${companyId})/extensions(${packageId})/Microsoft.NAV.${action}`;
    return bcAutomationRequest(tenantId, environment, "POST", path, { body: {} });
}
/** Default symbols output directory under OS temp. */
export function defaultSymbolsDir() {
    return join(tmpdir(), "origo-bc-mcp", "symbols");
}
export function defaultArtifactDir() {
    return join(tmpdir(), "origo-bc-mcp", "artifacts");
}
/**
 * Download a file from HTTPS (optional Bearer/Basic via authHeader).
 * Returns local path.
 */
export async function downloadToFile(url, destPath, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Download failed HTTP ${res.status} for ${url}: ${t.slice(0, 300)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, buf);
    return {
        path: destPath,
        bytes: buf.length,
        contentType: res.headers.get("content-type") ?? undefined,
    };
}
/** Extract .app files from a zip buffer into destDir; returns ordered paths found. */
export async function extractAppsFromZip(zipPath, destDir) {
    // Prefer unzip CLI if present; fallback to manual central-directory free approach via `unzip`.
    mkdirSync(destDir, { recursive: true });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
        await execFileAsync("unzip", ["-o", zipPath, "-d", destDir], { timeout: 120_000 });
    }
    catch {
        // Windows / no unzip: try PowerShell Expand-Archive
        try {
            await execFileAsync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], { timeout: 120_000 });
        }
        catch (e) {
            throw new Error(`Failed to extract zip (need unzip or PowerShell Expand-Archive): ${e instanceof Error ? e.message : e}`);
        }
    }
    const { readdirSync, statSync } = await import("node:fs");
    const apps = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory())
                walk(p);
            else if (name.toLowerCase().endsWith(".app"))
                apps.push(p);
        }
    };
    walk(destDir);
    return apps;
}
export function schemaUpdateModeQuery(mode) {
    const m = (mode ?? "synchronize").trim() || "synchronize";
    return `SchemaUpdateMode=${encodeURIComponent(m)}`;
}
export function tenantQuery(conn, tenantOverride) {
    const tenant = tenantOverride ?? conn.onPremTenant ?? (conn.onPrem ? "default" : undefined);
    return tenant ? `tenant=${encodeURIComponent(tenant)}` : "";
}
/** Build multipart body for /dev/apps publish (field name = file name, matching VS Code / ALbuild). */
export function buildAppMultipart(fileName, bytes) {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
    form.append(fileName, blob, fileName);
    return { body: form, fileName };
}
export function readAppBytes(appPath, appBase64) {
    if (appPath) {
        if (!existsSync(appPath))
            throw new Error(`appPath not found: ${appPath}`);
        return { bytes: readFileSync(appPath), fileName: basename(appPath) };
    }
    if (appBase64) {
        const bytes = Buffer.from(appBase64, "base64");
        return { bytes, fileName: "app.app" };
    }
    throw new Error("Provide appPath or appBase64.");
}
//# sourceMappingURL=developer.js.map