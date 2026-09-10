/**
 * BC Developer Services MCP tools — metadata, symbols, publish .app / artifacts,
 * uninstall/unpublish via Automation API, and AL unit tests (bc_dev_run_tests).
 *
 * Still out of scope: alc compile orchestration, container CRUD
 * (use Cosmo Alpaca lifecycle tools instead).
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { getAuthContext } from "../auth/context.js";
import { resolveTarget, json } from "../bc/runtime.js";
import { resolveDeveloperBaseUrl, bcDevRequest, findExtensions, automationBoundAction, automationAuthError, defaultSymbolsDir, defaultArtifactDir, downloadToFile, extractAppsFromZip, schemaUpdateModeQuery, tenantQuery, buildAppMultipart, readAppBytes, } from "../bc/developer.js";
import { runBcTests } from "../bc/runTests.js";
const schemaUpdateModeEnum = z
    .enum(["Synchronize", "Recreate", "ForceSync", "synchronize", "recreate", "forcesync"])
    .optional()
    .describe("SchemaUpdateMode for /dev/apps (default Synchronize).");
function normalizeSchemaMode(mode) {
    if (!mode)
        return "Synchronize";
    const lower = mode.toLowerCase();
    if (lower === "recreate")
        return "Recreate";
    if (lower === "forcesync")
        return "ForceSync";
    return "Synchronize";
}
async function publishAppFile(appPath, opts) {
    const ctx = getAuthContext();
    const { bytes, fileName } = readAppBytes(appPath);
    const tq = tenantQuery(ctx.conn, opts.tenant);
    const sq = schemaUpdateModeQuery(normalizeSchemaMode(opts.schemaUpdateMode));
    const qs = [tq, sq].filter(Boolean).join("&");
    const { body } = buildAppMultipart(fileName, bytes);
    const res = await bcDevRequest("POST", `/dev/apps${qs ? `?${qs}` : ""}`, {
        body,
    });
    return {
        fileName,
        bytes: bytes.length,
        statusCode: res.status,
        durationMs: res.durationMs,
        developerBaseUrl: resolveDeveloperBaseUrl(ctx.conn),
        body: res.body,
        ok: res.status >= 200 && res.status < 300,
        ...(res.status >= 400
            ? { error: typeof res.body === "string" ? res.body : res.body ?? res.rawText.slice(0, 500) }
            : {}),
    };
}
/**
 * Resolve artifact download URL from:
 * - plain HTTPS URL to .app or .zip
 * - Azure DevOps build artifact (downloadUrl or REST build artifacts API URL)
 * - GitHub Actions artifact download URL / release asset URL
 */
async function resolveArtifactDownload(input) {
    if (input.url) {
        const headers = {};
        // Optional tokens via env when caller didn't pass dedicated auth blocks
        if (process.env.ADO_PAT && /dev\.azure\.com|visualstudio\.com/i.test(input.url)) {
            headers.Authorization =
                "Basic " + Buffer.from(`:${process.env.ADO_PAT}`).toString("base64");
        }
        if (process.env.GITHUB_TOKEN && /github\.com|api\.github\.com/i.test(input.url)) {
            headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
            headers.Accept = "application/octet-stream";
        }
        const name = basename(new URL(input.url).pathname) || `artifact-${randomUUID()}`;
        return { downloadUrl: input.url, headers, suggestedName: name };
    }
    if (input.azureDevOps) {
        const { organization, project, buildId, artifactName, pat } = input.azureDevOps;
        const token = pat ?? process.env.ADO_PAT ?? process.env.AZURE_DEVOPS_EXT_PAT;
        if (!token) {
            throw new Error("Azure DevOps artifact download requires pat or ADO_PAT / AZURE_DEVOPS_EXT_PAT.");
        }
        const auth = "Basic " + Buffer.from(`:${token}`).toString("base64");
        const listUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}` +
            `/_apis/build/builds/${encodeURIComponent(String(buildId))}/artifacts?api-version=7.1`;
        const listRes = await fetch(listUrl, { headers: { Authorization: auth } });
        if (!listRes.ok) {
            throw new Error(`ADO artifacts list failed HTTP ${listRes.status}: ${(await listRes.text()).slice(0, 300)}`);
        }
        const list = (await listRes.json());
        const art = (list.value ?? []).find((a) => a.name === artifactName);
        if (!art?.resource?.downloadUrl) {
            throw new Error(`Artifact '${artifactName}' not found on build ${buildId}. Available: ${(list.value ?? []).map((a) => a.name).join(", ")}`);
        }
        return {
            downloadUrl: art.resource.downloadUrl,
            headers: { Authorization: auth },
            suggestedName: `${artifactName}.zip`,
        };
    }
    if (input.github) {
        const { owner, repo, artifactId, releaseTag, assetName, token } = input.github;
        const ghToken = token ?? process.env.GITHUB_TOKEN;
        const headers = {
            "User-Agent": "origo-bc-mcp",
            Accept: "application/vnd.github+json",
        };
        if (ghToken)
            headers.Authorization = `Bearer ${ghToken}`;
        if (artifactId) {
            // Actions artifact archive
            const downloadUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
                `/actions/artifacts/${encodeURIComponent(String(artifactId))}/zip`;
            return {
                downloadUrl,
                headers: { ...headers, Accept: "application/octet-stream" },
                suggestedName: `gh-artifact-${artifactId}.zip`,
            };
        }
        if (releaseTag && assetName) {
            const relUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
                `/releases/tags/${encodeURIComponent(releaseTag)}`;
            const relRes = await fetch(relUrl, { headers });
            if (!relRes.ok) {
                throw new Error(`GitHub release lookup failed HTTP ${relRes.status}`);
            }
            const rel = (await relRes.json());
            const asset = (rel.assets ?? []).find((a) => a.name === assetName);
            if (!asset) {
                throw new Error(`Release asset '${assetName}' not found. Available: ${(rel.assets ?? []).map((a) => a.name).join(", ")}`);
            }
            return {
                downloadUrl: asset.url,
                headers: { ...headers, Accept: "application/octet-stream" },
                suggestedName: assetName,
            };
        }
        throw new Error("github requires artifactId, or releaseTag + assetName.");
    }
    throw new Error("Provide url, azureDevOps, or github artifact source.");
}
export function registerDevServicesTools(server) {
    // ── bc_dev_get_metadata ───────────────────────────────────────────────────
    server.registerTool("bc_dev_get_metadata", {
        title: "Get BC Developer Services metadata",
        description: "GET {developerBase}/dev/metadata — returns the environment's developer services metadata " +
            "(runtime version, etc.). On Alpaca, developerBase is derived from REST baseUrl by replacing " +
            "trailing 'rest' with 'dev', or from explicit developerBaseUrl.",
        inputSchema: {},
    }, async () => {
        const ctx = getAuthContext();
        const base = resolveDeveloperBaseUrl(ctx.conn);
        const res = await bcDevRequest("GET", "/dev/metadata", {
            accept: "application/json",
        });
        return json({
            developerBaseUrl: base,
            statusCode: res.status,
            durationMs: res.durationMs,
            metadata: res.body,
            ...(res.status >= 400 ? { error: res.body ?? res.rawText.slice(0, 500) } : {}),
        });
    });
    // ── bc_dev_get_symbols ────────────────────────────────────────────────────
    server.registerTool("bc_dev_get_symbols", {
        title: "Download BC symbol packages",
        description: "GET {developerBase}/dev/packages?publisher&appName&versionText&tenant — downloads symbol " +
            ".app packages to disk and returns the path + size (does NOT dump megabytes of base64).",
        inputSchema: {
            publisher: z.string().describe("Publisher, e.g. 'Microsoft'."),
            appName: z.string().describe("App name, e.g. 'Application' or 'System'."),
            versionText: z.string().describe("Version text, e.g. '28.0.0.0'."),
            tenant: z.string().optional().describe("Tenant id (default: onPremTenant or 'default')."),
            outputDir: z.string().optional().describe("Directory to write the package (default: OS temp)."),
            outputFileName: z.string().optional().describe("Optional file name override."),
        },
    }, async ({ publisher, appName, versionText, tenant, outputDir, outputFileName }) => {
        const ctx = getAuthContext();
        const tq = tenantQuery(ctx.conn, tenant);
        const params = new URLSearchParams({
            publisher,
            appName,
            versionText,
        });
        if (tq) {
            const tenantVal = tq.split("=")[1];
            params.set("tenant", decodeURIComponent(tenantVal));
        }
        const dir = outputDir ?? defaultSymbolsDir();
        mkdirSync(dir, { recursive: true });
        const fileName = outputFileName ??
            `${publisher.replace(/\W+/g, "_")}.${appName.replace(/\W+/g, "_")}.${versionText}.app`;
        const outPath = join(dir, fileName);
        const res = await bcDevRequest("GET", `/dev/packages?${params.toString()}`, {
            saveToPath: outPath,
            accept: "application/octet-stream",
        });
        if (res.status >= 400) {
            return json({
                error: `Symbol download failed HTTP ${res.status}`,
                statusCode: res.status,
                path: outPath,
                bytes: res.savedBytes ?? 0,
                bodyPreview: res.rawText?.slice(0, 400),
            });
        }
        return json({
            publisher,
            appName,
            versionText,
            statusCode: res.status,
            durationMs: res.durationMs,
            path: res.savedPath ?? outPath,
            bytes: res.savedBytes ?? 0,
            developerBaseUrl: resolveDeveloperBaseUrl(ctx.conn),
        });
    });
    // ── bc_dev_publish_app ────────────────────────────────────────────────────
    server.registerTool("bc_dev_publish_app", {
        title: "Publish .app via Developer Services",
        description: "POST multipart to {developerBase}/dev/apps?tenant&SchemaUpdateMode=… — the VS Code / Alpaca " +
            "dev publish path (verified HTTP 200 on Cosmo Alpaca). Accepts appPath on disk or appBase64+fileName. " +
            "Does not use Cosmo ExecDeployApp (feeds only); this is the multipart DEV endpoint.",
        inputSchema: {
            appPath: z.string().optional().describe("Path to a .app file on disk."),
            appBase64: z.string().optional().describe("Base64-encoded .app (prefer appPath for large files)."),
            fileName: z.string().optional().describe("File name when using appBase64 (default app.app)."),
            tenant: z.string().optional(),
            schemaUpdateMode: schemaUpdateModeEnum,
        },
    }, async ({ appPath, appBase64, fileName, tenant, schemaUpdateMode }) => {
        if (!appPath && !appBase64) {
            throw new Error("Provide appPath or appBase64.");
        }
        let pathToPublish = appPath;
        if (!pathToPublish && appBase64) {
            const dir = defaultArtifactDir();
            mkdirSync(dir, { recursive: true });
            pathToPublish = join(dir, fileName ?? "app.app");
            writeFileSync(pathToPublish, Buffer.from(appBase64, "base64"));
        }
        const result = await publishAppFile(pathToPublish, {
            tenant,
            schemaUpdateMode: normalizeSchemaMode(schemaUpdateMode),
        });
        return json(result);
    });
    // ── bc_dev_publish_artifact ───────────────────────────────────────────────
    server.registerTool("bc_dev_publish_artifact", {
        title: "Publish .app from HTTPS / ADO / GitHub artifact",
        description: "Downloads .app (or a zip of apps) from an HTTPS URL, Azure DevOps build artifact, or " +
            "GitHub Actions artifact / release asset, then publishes via /dev/apps in order. " +
            "Supports an ordered list for dependency publish (Foundation → feature → tests). " +
            "Note: Cosmo ExecDeployApp only installs from NuGet|AzureDevOps feeds — this tool covers " +
            "GitHub Actions artifacts and arbitrary HTTPS .app URLs.",
        inputSchema: {
            artifacts: z
                .array(z.object({
                url: z.string().url().optional().describe("Direct HTTPS URL to .app or .zip."),
                azureDevOps: z
                    .object({
                    organization: z.string(),
                    project: z.string(),
                    buildId: z.union([z.number(), z.string()]),
                    artifactName: z.string(),
                    pat: z.string().optional().describe("Prefer ADO_PAT / AZURE_DEVOPS_EXT_PAT env over tool args."),
                })
                    .optional(),
                github: z
                    .object({
                    owner: z.string(),
                    repo: z.string(),
                    artifactId: z.union([z.number(), z.string()]).optional(),
                    releaseTag: z.string().optional(),
                    assetName: z.string().optional(),
                    token: z.string().optional().describe("Prefer GITHUB_TOKEN env over tool args."),
                })
                    .optional(),
                /** When the download is a zip with multiple apps, optional ordered .app file name filters. */
                appFileNames: z
                    .array(z.string())
                    .optional()
                    .describe("Ordered .app basenames to publish from a zip (dependency order)."),
            }))
                .min(1)
                .describe("Ordered artifact sources to download and publish."),
            tenant: z.string().optional(),
            schemaUpdateMode: schemaUpdateModeEnum,
            outputDir: z.string().optional(),
        },
    }, async ({ artifacts, tenant, schemaUpdateMode, outputDir }) => {
        const dir = outputDir ?? join(defaultArtifactDir(), randomUUID());
        mkdirSync(dir, { recursive: true });
        const published = [];
        const mode = normalizeSchemaMode(schemaUpdateMode);
        for (let i = 0; i < artifacts.length; i++) {
            const art = artifacts[i];
            const resolved = await resolveArtifactDownload(art);
            const dest = join(dir, `${i}-${resolved.suggestedName}`);
            const dl = await downloadToFile(resolved.downloadUrl, dest, resolved.headers);
            let appPaths = [];
            if (dl.path.toLowerCase().endsWith(".app")) {
                appPaths = [dl.path];
            }
            else if (dl.path.toLowerCase().endsWith(".zip") ||
                (dl.contentType ?? "").includes("zip")) {
                const extractDir = join(dir, `extract-${i}`);
                const found = await extractAppsFromZip(dl.path, extractDir);
                if (art.appFileNames?.length) {
                    appPaths = art.appFileNames.map((name) => {
                        const match = found.find((p) => basename(p).toLowerCase() === name.toLowerCase());
                        if (!match) {
                            throw new Error(`appFileName '${name}' not found in zip. Found: ${found.map((p) => basename(p)).join(", ")}`);
                        }
                        return match;
                    });
                }
                else {
                    // Stable order by basename
                    appPaths = found.sort((a, b) => basename(a).localeCompare(basename(b)));
                }
            }
            else if (existsSync(dl.path) && readFileSync(dl.path).subarray(0, 2).toString() === "PK") {
                const extractDir = join(dir, `extract-${i}`);
                const found = await extractAppsFromZip(dl.path, extractDir);
                appPaths = art.appFileNames?.length
                    ? art.appFileNames.map((name) => {
                        const match = found.find((p) => basename(p).toLowerCase() === name.toLowerCase());
                        if (!match)
                            throw new Error(`appFileName '${name}' not in zip`);
                        return match;
                    })
                    : found.sort((a, b) => basename(a).localeCompare(basename(b)));
            }
            else {
                // Assume raw .app even without extension
                appPaths = [dl.path];
            }
            for (const appPath of appPaths) {
                const result = await publishAppFile(appPath, { tenant, schemaUpdateMode: mode });
                published.push({ sourceIndex: i, appPath, ...result });
                if (!result.ok) {
                    return json({
                        stopped: true,
                        reason: `Publish failed for ${basename(appPath)} HTTP ${result.statusCode}`,
                        published,
                        outputDir: dir,
                    });
                }
            }
        }
        return json({
            ok: true,
            publishedCount: published.length,
            published,
            outputDir: dir,
        });
    });
    // ── bc_dev_uninstall_app ──────────────────────────────────────────────────
    server.registerTool("bc_dev_uninstall_app", {
        title: "Uninstall app via Automation API",
        description: "Uninstalls an extension using the Automation API bound action Microsoft.NAV.uninstall " +
            "(NOT DELETE /dev/apps — that returns 404 on Alpaca). " +
            "On 401/403 returns a clear error; fallback is SSH Uninstall-NavApp. " +
            "Container create/delete/start/stop belongs to Cosmo Alpaca VS Code tools, not this MCP.",
        inputSchema: {
            publisher: z.string().optional(),
            name: z.string().optional().describe("Extension display name."),
            versionText: z.string().optional().describe("e.g. 28.0.0.49"),
            appId: z.string().optional().describe("App id or packageId GUID."),
            packageId: z.string().optional().describe("Automation packageId if already known."),
            deleteExtensionData: z
                .boolean()
                .optional()
                .describe("If true, call uninstallAndDeleteExtensionData instead."),
            companyId: z.string().optional(),
        },
    }, async ({ publisher, name, versionText, appId, packageId, deleteExtensionData, companyId }) => {
        const t = await resolveTarget({ companyId });
        let pkg = packageId;
        let matched = [];
        if (!pkg) {
            matched = await findExtensions(t.tenantId, t.environment, t.companyId, {
                publisher,
                name,
                versionText,
                appId,
            });
            if (!matched.length) {
                return json({
                    error: "No matching extension found via Automation API.",
                    filter: { publisher, name, versionText, appId },
                });
            }
            if (matched.length > 1 && !versionText && !appId) {
                return json({
                    error: "Multiple extensions matched; pass versionText or appId/packageId.",
                    matches: matched,
                });
            }
            pkg = matched[0].packageId;
        }
        const action = deleteExtensionData ? "uninstallAndDeleteExtensionData" : "uninstall";
        const res = await automationBoundAction(t.tenantId, t.environment, t.companyId, pkg, action);
        const authErr = automationAuthError(res.status, res.body);
        if (authErr) {
            return json({ error: authErr, statusCode: res.status, packageId: pkg });
        }
        return json({
            action,
            packageId: pkg,
            statusCode: res.status,
            durationMs: res.durationMs,
            ok: res.status >= 200 && res.status < 300,
            body: res.body,
            match: matched[0],
            ...(res.status >= 400
                ? {
                    error: `Automation ${action} failed HTTP ${res.status}. ` +
                        `Fallback: SSH Uninstall-NavApp. Body: ${res.rawText.slice(0, 400)}`,
                }
                : {}),
        });
    });
    // ── bc_dev_unpublish_app ──────────────────────────────────────────────────
    server.registerTool("bc_dev_unpublish_app", {
        title: "Unpublish app via Automation API",
        description: "Unpublishes an uninstalled extension via Automation API Microsoft.NAV.unpublish " +
            "(BC 25.4+; NOT DELETE /dev/apps). Extension should be uninstalled first. " +
            "On 401/403 returns a clear error; fallback is SSH Unpublish-NavApp. " +
            "Cosmo DeployApp installs from feeds — it does not uninstall/unpublish.",
        inputSchema: {
            publisher: z.string().optional(),
            name: z.string().optional(),
            versionText: z.string().optional(),
            appId: z.string().optional(),
            packageId: z.string().optional(),
            companyId: z.string().optional(),
        },
    }, async ({ publisher, name, versionText, appId, packageId, companyId }) => {
        const t = await resolveTarget({ companyId });
        let pkg = packageId;
        let matched = [];
        if (!pkg) {
            matched = await findExtensions(t.tenantId, t.environment, t.companyId, {
                publisher,
                name,
                versionText,
                appId,
            });
            if (!matched.length) {
                return json({
                    error: "No matching extension found via Automation API.",
                    filter: { publisher, name, versionText, appId },
                });
            }
            if (matched.length > 1 && !versionText && !appId) {
                return json({
                    error: "Multiple extensions matched; pass versionText or appId/packageId.",
                    matches: matched,
                });
            }
            pkg = matched[0].packageId;
            if (matched[0]?.isInstalled) {
                return json({
                    error: "Extension is still installed. Call bc_dev_uninstall_app first, then unpublish. " +
                        "Fallback: SSH Uninstall-NavApp then Unpublish-NavApp.",
                    match: matched[0],
                });
            }
        }
        const res = await automationBoundAction(t.tenantId, t.environment, t.companyId, pkg, "unpublish");
        const authErr = automationAuthError(res.status, res.body);
        if (authErr) {
            return json({ error: authErr, statusCode: res.status, packageId: pkg });
        }
        return json({
            action: "unpublish",
            packageId: pkg,
            statusCode: res.status,
            durationMs: res.durationMs,
            ok: res.status >= 200 && res.status < 300,
            body: res.body,
            match: matched[0],
            ...(res.status >= 400
                ? {
                    error: `Automation unpublish failed HTTP ${res.status} (requires BC 25.4+ and app uninstalled). ` +
                        `Fallback: SSH Unpublish-NavApp. Body: ${res.rawText.slice(0, 400)}`,
                }
                : {}),
        });
    });
    // ── bc_dev_run_tests ──────────────────────────────────────────────────────
    server.registerTool("bc_dev_run_tests", {
        title: "Run AL unit tests (Cosmo SSH / BcContainerHelper)",
        description: "Runs AL unit tests against the connected container. " +
            "Preferred: Cosmo SSH when cosmo_ssh_info.available=true — SSH as sshuser with privateKey and " +
            "invoke Invoke-NavContainerTests / Run-TestsInBcContainer / Run-AlTests on the remote host. " +
            "If SSH available=false: returns a clear blocked error (no silent fallback) with Stop→Start " +
            "recreate + create-with-sshEnabled=true hints. " +
            "Cosmo has no /Container/Exec/{id} test-runner endpoint (only deployApp/appinfo/restartServerInstance/…). " +
            "mode=helper is local-docker only (containerName). Reuses stdio/devConnection NavUserPassword auth. " +
            "Returns structured passed/failed/skipped + failure messages (not megabyte dumps). " +
            "Cosmo lifecycle tools stay separate (cosmo_*).",
        inputSchema: {
            extensionId: z
                .string()
                .optional()
                .describe("App id (GUID) of the test extension — runs tests in that app when supported."),
            testCodeunit: z
                .string()
                .optional()
                .describe("Optional test codeunit id or name filter."),
            testFunction: z.string().optional().describe("Optional test function name filter."),
            testSuite: z.string().optional().describe("Test suite name (default DEFAULT)."),
            companyName: z
                .string()
                .optional()
                .describe("Company to run tests in (default: connection companyName or CRONUS IS)."),
            tenant: z.string().optional().describe("Tenant (default: onPremTenant or default)."),
            containerId: z
                .string()
                .optional()
                .describe("Cosmo container id — required for mode=auto|ssh (e.g. f0a4d51d4d47)."),
            containerName: z
                .string()
                .optional()
                .describe("Local docker BC container name (mode=helper only)."),
            mode: z
                .enum(["auto", "ssh", "helper"])
                .optional()
                .describe("auto/ssh: Cosmo SSH path; helper: local docker only. Default auto."),
            sshUser: z
                .string()
                .optional()
                .describe("SSH username (default sshuser / COSMO_SSH_USER)."),
            detailed: z.boolean().optional().describe("Pass -detailed to the remote test helper (default true)."),
            timeoutMs: z
                .number()
                .optional()
                .describe("Kill the SSH/PowerShell run after this many ms (default 900000 = 15 min)."),
        },
    }, async (args) => {
        const ctx = getAuthContext();
        const result = await runBcTests(args, ctx.conn);
        return json(result);
    });
}
//# sourceMappingURL=devServices.js.map