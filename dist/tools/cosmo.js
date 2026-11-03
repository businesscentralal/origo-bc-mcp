/**
 * Cosmo Alpaca lifecycle tools (same MCP server as bc_dev_*).
 * API paths from Cosmo Alpaca VS Code extension 1.27.
 */
import { z } from "zod";
import { json } from "../bc/runtime.js";
import { cosmoRequest, cosmoErrorHint, deriveBcEndpoints, getCosmoConfig, redactCosmoSecrets, redactCosmoText, } from "../cosmo/client.js";
import { ensureCosmoSsh } from "../cosmo/ssh.js";
import { premiumAfterCreate } from "../bc/premiumPlan.js";
const backendUrlField = z
    .string()
    .optional()
    .describe("Optional Cosmo backendUrl override (prefer parent org/repo backendUrl from Cosmo). " +
    "Must be the Alpaca API base (.../api/alpaca/release), not the bare public host. " +
    "Defaults to COSMO_BACKEND_URL / cosmo.backendUrl / enterprise release base.");
const containerIdField = z.string().describe("Cosmo container id (e.g. f0a4d51d4d47).");
const bcArtifactSchema = z
    .object({
    storageAccount: z.enum(["BcArtifacts", "BcInsider"]).optional(),
    type: z.enum(["Sandbox", "OnPrem"]).optional(),
    version: z.string().optional(),
    country: z.string().optional(),
    select: z.string().optional(),
})
    .optional();
function resultPayload(res, extra) {
    const hint = cosmoErrorHint(res.status, res.body);
    return {
        statusCode: res.status,
        durationMs: res.durationMs,
        url: res.url,
        ok: res.status >= 200 && res.status < 300,
        body: redactCosmoSecrets(res.body),
        ...(hint
            ? { error: hint }
            : res.status >= 400
                ? { error: redactCosmoText(res.rawText.slice(0, 500)) || redactCosmoSecrets(res.body) }
                : {}),
        ...extra,
    };
}
function envSeconds(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function stripUndefined(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
export function registerCosmoTools(server) {
    // ── cosmo_list_containers ─────────────────────────────────────────────────
    server.registerTool("cosmo_list_containers", {
        title: "List Cosmo BC containers",
        description: "POST /Container/Container/filter — GetContainersOfUser. Lists BC containers for the " +
            "authenticated Cosmo user (Bearer). Use before create/delete.",
        inputSchema: {
            backendUrl: backendUrlField,
            filter: z
                .record(z.unknown())
                .optional()
                .describe("Optional GetContainersFilter body (default {})."),
        },
    }, async ({ backendUrl, filter }) => {
        const res = await cosmoRequest("POST", "/Container/Container/filter", {
            backendUrl,
            body: filter ?? {},
        });
        return json(resultPayload(res));
    });
    // ── cosmo_get_container ───────────────────────────────────────────────────
    server.registerTool("cosmo_get_container", {
        title: "Get Cosmo container",
        description: "GET /Container/Container/{containerId}. Returns container info and derived " +
            "`…/{id}rest` / `…/{id}dev` URLs for wiring origo-bc-mcp `devConnection`.",
        inputSchema: {
            containerId: containerIdField,
            backendUrl: backendUrlField,
            publicHost: z
                .string()
                .optional()
                .describe("Public host for REST/DEV derivation (default Cosmo enterprise host)."),
        },
    }, async ({ containerId, backendUrl, publicHost }) => {
        const res = await cosmoRequest("GET", `/Container/Container/${encodeURIComponent(containerId)}`, {
            backendUrl,
        });
        const endpoints = deriveBcEndpoints(containerId, publicHost);
        return json(resultPayload(res, {
            derivedEndpoints: endpoints,
            wiringHint: "Set devConnection.onPrem baseUrl=derivedEndpoints.restBaseUrl and " +
                "developerBaseUrl=derivedEndpoints.developerBaseUrl (CRONUS IS), then use bc_dev_*.",
        }));
    });
    // ── cosmo_create_container ────────────────────────────────────────────────
    server.registerTool("cosmo_create_container", {
        title: "Create Cosmo BC container",
        description: "Creates a BC container via Cosmo Alpaca. " +
            "kind=generic → POST /Container/Container; " +
            "kind=github → POST /Container/Container/gitHub (CreateGitHubBcContainer); " +
            "kind=azureDevOps → POST /Container/Container/azureDevOps; " +
            "kind=standalone → POST /Container/Container/standalone. " +
            "Premium experience: enablePremium alone does NOT give a Premium experience on Cosmo dev containers - the " +
            "user stays on Essential and Company Information → Experience = Premium fails with 'you do not have a Premium " +
            "license'. Use assignPremiumPlan=true (kind=generic): sends enablePremium, waits until the container is Running " +
            "(waitTimeoutSeconds, default 1200), then assigns the Premium User Plan inside BC over SSH (as BcContainerHelper " +
            "-assignPremiumPlan) and returns the result under premiumPlan; if the wait runs out it returns the container id " +
            "and a hint to call bc_dev_assign_premium_plan once Running. kind=github/azureDevOps take it from the repo config " +
            "(AL-Go setting assignPremiumPlan / cosmo.json enablePremium); bc_dev_assign_premium_plan works on any container. " +
            "After create, derive …/{id}dev + …/{id}rest and call bc_dev_publish_*.",
        inputSchema: {
            kind: z
                .enum(["generic", "github", "azureDevOps", "standalone"])
                .default("generic")
                .describe("Which Cosmo create endpoint to call."),
            displayName: z.string().optional(),
            username: z.string().optional(),
            password: z.string().optional(),
            owner: z.string().optional(),
            state: z.enum(["Start", "Stop"]).optional(),
            sshEnabled: z.boolean().optional(),
            type: z.enum(["Dev", "Build", "Standalone"]).optional(),
            bcArtifact: bcArtifactSchema,
            enablePremium: z
                .boolean()
                .optional()
                .describe("Premium experience for the default admin user (Cosmo BcContainerRequest.enablePremium). " +
                "kind=generic only; for kind=github/azureDevOps set assignPremiumPlan (AL-Go) or enablePremium (cosmo.json) in the repo. " +
                "On its own it does not unlock the Premium experience - use assignPremiumPlan."),
            assignPremiumPlan: z
                .boolean()
                .optional()
                .describe("kind=generic only. Sends enablePremium + sshEnabled, waits for Running, then assigns the BC Premium plan to " +
                "every enabled Full User (bc_dev_assign_premium_plan) and returns that result."),
            waitTimeoutSeconds: z
                .number()
                .int()
                .min(0)
                .max(3600)
                .optional()
                .describe("assignPremiumPlan: how long to wait for Running before returning a hint instead (default " +
                "COSMO_PREMIUM_WAIT_S or 1200; keep it under your MCP client's tool-call timeout)."),
            /** Extra fields for GitHub/ADO create bodies (org, repo, project, branch, …). */
            source: z
                .record(z.unknown())
                .optional()
                .describe("Additional create payload fields (e.g. organization, project, repository, branch)."),
            backendUrl: backendUrlField,
        },
    }, async ({ kind, displayName, username, password, owner, state, sshEnabled, type, bcArtifact, enablePremium, assignPremiumPlan, waitTimeoutSeconds, source, backendUrl, }) => {
        if ((enablePremium !== undefined || assignPremiumPlan) && kind !== "generic") {
            throw new Error("enablePremium/assignPremiumPlan apply to kind=generic only. For kind=github set \"assignPremiumPlan\": true in the repo's " +
                ".AL-Go/settings.json; for kind=azureDevOps set \"enablePremium\": true in cosmo.json " +
                "(or call bc_dev_assign_premium_plan once the container is Running).");
        }
        if (assignPremiumPlan) {
            if (enablePremium === false)
                throw new Error("assignPremiumPlan=true conflicts with enablePremium=false.");
            if (sshEnabled === false)
                throw new Error("assignPremiumPlan=true needs SSH; do not set sshEnabled=false.");
            if (state === "Stop")
                throw new Error("assignPremiumPlan=true needs a started container; do not set state=Stop.");
            enablePremium = true;
            sshEnabled = true;
        }
        const body = stripUndefined({
            displayName,
            username,
            password,
            owner,
            state,
            sshEnabled,
            type,
            bcArtifact,
            enablePremium,
            ...(source ?? {}),
        });
        const path = kind === "github"
            ? "/Container/Container/gitHub"
            : kind === "azureDevOps"
                ? "/Container/Container/azureDevOps"
                : kind === "standalone"
                    ? "/Container/Container/standalone"
                    : "/Container/Container";
        const res = await cosmoRequest("POST", path, { backendUrl, body });
        const id = res.body?.id ||
            res.body?.containerId;
        const endpoints = id ? deriveBcEndpoints(String(id)) : undefined;
        if (!assignPremiumPlan)
            return json(resultPayload(res, { derivedEndpoints: endpoints }));
        const created = res.status >= 200 && res.status < 300;
        const premiumPlan = created && id
            ? await premiumAfterCreate(String(id), {
                waitTimeoutSeconds: waitTimeoutSeconds ?? envSeconds("COSMO_PREMIUM_WAIT_S", 1200),
                pollSeconds: envSeconds("COSMO_PREMIUM_POLL_S", 15),
                backendUrl,
            })
            : {
                assigned: false,
                hint: created
                    ? "Create returned no container id; call bc_dev_assign_premium_plan with the id once it is Running."
                    : "Create failed; no Premium plan assigned.",
            };
        return json(resultPayload(res, { derivedEndpoints: endpoints, premiumPlan }));
    });
    // ── cosmo_update_container ────────────────────────────────────────────────
    server.registerTool("cosmo_update_container", {
        title: "Update Cosmo BC container",
        description: "PATCH /Container/Container/{containerId} — UpdateBcContainer (state Start|Stop, sshEnabled, autoStart/Stop, …).",
        inputSchema: {
            containerId: containerIdField,
            displayName: z.string().optional(),
            owner: z.string().optional(),
            state: z.enum(["Start", "Stop"]).optional(),
            sshEnabled: z.boolean().optional(),
            autoStartInfo: z.record(z.unknown()).optional(),
            autoStopInfo: z.record(z.unknown()).optional(),
            inactivityInfo: z.record(z.unknown()).optional(),
            customNavSettings: z.array(z.record(z.unknown())).optional(),
            backendUrl: backendUrlField,
        },
    }, async (args) => {
        const { containerId, backendUrl, ...rest } = args;
        const body = stripUndefined(rest);
        const res = await cosmoRequest("PATCH", `/Container/Container/${encodeURIComponent(containerId)}`, { backendUrl, body });
        return json(resultPayload(res));
    });
    // ── cosmo_delete_container ────────────────────────────────────────────────
    server.registerTool("cosmo_delete_container", {
        title: "Delete Cosmo BC container",
        description: "DELETE /Container/Container/{containerId} — DeleteContainer. End of ephemeral PR/project lifecycle.",
        inputSchema: {
            containerId: containerIdField,
            backendUrl: backendUrlField,
        },
    }, async ({ containerId, backendUrl }) => {
        const res = await cosmoRequest("DELETE", `/Container/Container/${encodeURIComponent(containerId)}`, { backendUrl });
        return json(resultPayload(res));
    });
    // ── cosmo_deploy_app ──────────────────────────────────────────────────────
    server.registerTool("cosmo_deploy_app", {
        title: "Deploy app into Cosmo container (feeds)",
        description: "POST /Container/Exec/{containerId}/deployApp — Cosmo ExecDeployApp from NuGet or AzureDevOps feeds only. " +
            "For GitHub Actions artifacts / arbitrary HTTPS .app use bc_dev_publish_artifact instead.",
        inputSchema: {
            containerId: containerIdField,
            source: z.enum(["NuGet", "AzureDevOps"]),
            nuGet: z
                .object({
                name: z.string(),
                version: z.string().optional(),
            })
                .optional(),
            azureDevOps: z
                .object({
                organization: z.string(),
                project: z.string().optional(),
                feed: z.string(),
                name: z.string(),
                scope: z.enum(["Organization", "Project"]).optional(),
                version: z.string().optional(),
                view: z.string().optional(),
                pat: z.string().optional().describe("Prefer ADO_PAT / AZURE_DEVOPS_EXT_PAT env instead of passing PAT in tool args."),
            })
                .optional(),
            backendUrl: backendUrlField,
        },
    }, async ({ containerId, source, nuGet, azureDevOps, backendUrl }) => {
        if (source === "NuGet" && !nuGet?.name)
            throw new Error("nuGet.name required when source=NuGet");
        if (source === "AzureDevOps" && !azureDevOps) {
            throw new Error("azureDevOps object required when source=AzureDevOps");
        }
        const body = stripUndefined({ source, nuGet, azureDevOps });
        const res = await cosmoRequest("POST", `/Container/Exec/${encodeURIComponent(containerId)}/deployApp`, { backendUrl, body });
        return json(resultPayload(res));
    });
    // ── cosmo_get_app_info ────────────────────────────────────────────────────
    server.registerTool("cosmo_get_app_info", {
        title: "Get published/installed apps in Cosmo container",
        description: "GET /Container/Exec/{containerId}/appinfo",
        inputSchema: {
            containerId: containerIdField,
            backendUrl: backendUrlField,
        },
    }, async ({ containerId, backendUrl }) => {
        const res = await cosmoRequest("GET", `/Container/Exec/${encodeURIComponent(containerId)}/appinfo`, { backendUrl, binary: true });
        return json(resultPayload(res));
    });
    // ── cosmo_ssh_info ────────────────────────────────────────────────────────
    server.registerTool("cosmo_ssh_info", {
        title: "Get Cosmo container SSH info",
        description: "GET /Container/Ssh/{containerId}. Use for SSH Uninstall-NavApp / Unpublish-NavApp fallback after Automation API. " +
            "Read-only; to bring SSH back when it is missing use cosmo_ensure_ssh. " +
            "The private key is never returned: privateKeyPresent says whether SSH is usable (bc_dev_run_tests " +
            "and bc_dev_build_runtime_package read the key themselves).",
        inputSchema: {
            containerId: containerIdField,
            backendUrl: backendUrlField,
        },
    }, async ({ containerId, backendUrl }) => {
        const res = await cosmoRequest("GET", `/Container/Ssh/${encodeURIComponent(containerId)}`, {
            backendUrl,
        });
        const raw = res.body && typeof res.body === "object" ? res.body : {};
        const key = raw.privateKey ?? raw.PrivateKey;
        return json(resultPayload(res, {
            privateKeyPresent: typeof key === "string" && key.trim().length > 0,
            ipAddressPresent: typeof (raw.ipAddress ?? raw.host) === "string",
        }));
    });
    // ── cosmo_ensure_ssh ──────────────────────────────────────────────────────
    server.registerTool("cosmo_ensure_ssh", {
        title: "Make Cosmo container SSH usable",
        description: "Checks GET /Container/Ssh/{id}; when it has no ipAddress/privateKey or the port refuses TCP, " +
            "PATCHes sshEnabled=true (or starts a stopped container with sshEnabled=true) and polls until SSH is " +
            "usable. With allowRestart=true it Stop → Starts the container as a last resort (interrupts anyone " +
            "using it). Returns ready, the ip/port, the steps taken and timing - never the private key. " +
            "bc_dev_run_tests and bc_dev_build_runtime_package call this themselves (without restart).",
        inputSchema: {
            containerId: containerIdField,
            waitSeconds: z
                .number()
                .optional()
                .describe("How long to wait for SSH after enabling it (default BC_DEV_SSH_ENSURE_WAIT_S or 300)."),
            pollSeconds: z.number().optional().describe("Poll interval (default 10)."),
            allowRestart: z
                .boolean()
                .optional()
                .describe("Stop → Start the container when enabling alone does not bring SSH up (default false)."),
        },
    }, async ({ containerId, waitSeconds, pollSeconds, allowRestart }) => {
        const { result } = await ensureCosmoSsh(containerId, { waitSeconds, pollSeconds, allowRestart });
        return json(result);
    });
    // ── cosmo_restart_nst ─────────────────────────────────────────────────────
    server.registerTool("cosmo_restart_nst", {
        title: "Restart BC server instance in Cosmo container",
        description: "POST /Container/Exec/{containerId}/restartServerInstance (optional NST restart).",
        inputSchema: {
            containerId: containerIdField,
            backendUrl: backendUrlField,
        },
    }, async ({ containerId, backendUrl }) => {
        const res = await cosmoRequest("POST", `/Container/Exec/${encodeURIComponent(containerId)}/restartServerInstance`, { backendUrl });
        return json(resultPayload(res));
    });
    // ── cosmo_config_check (lightweight helper, not required but useful) ──────
    server.registerTool("cosmo_whoami_config", {
        title: "Show Cosmo client config (no secrets)",
        description: "Shows resolved Cosmo backendUrl and whether a bearer token is configured (token value never returned).",
        inputSchema: {
            backendUrl: backendUrlField,
        },
    }, async ({ backendUrl }) => {
        try {
            const cfg = getCosmoConfig({ backendUrl });
            return json({
                backendUrl: cfg.backendUrl,
                bearerTokenConfigured: true,
                bearerTokenLength: cfg.bearerToken.length,
                defaultBackendUrl: "https://cosmo-alpaca-enterprise.westeurope.cloudapp.azure.com/api/alpaca/release",
                defaultPublicHost: "https://cosmo-alpaca-enterprise.westeurope.cloudapp.azure.com",
                howToObtainToken: "Use the Bearer token from a signed-in Cosmo Alpaca VS Code 1.27 session " +
                    "(GitHub or Azure DevOps auth provider), or set COSMO_BEARER_TOKEN / cosmo.bearerToken.",
            });
        }
        catch (e) {
            return json({
                backendUrl: backendUrl || process.env.COSMO_BACKEND_URL || null,
                bearerTokenConfigured: false,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    });
}
//# sourceMappingURL=cosmo.js.map