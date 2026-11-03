/**
 * Run one PowerShell script inside a Cosmo BC container over SSH.
 *
 * Same transport as bc_dev_run_tests / bc_dev_build_runtime_package: ensureCosmoSsh, write the
 * private key to a 0600 temp file, scp the script to C:\Windows\Temp, run it with
 * `powershell.exe -NoProfile -File` (the NAV management cmdlets are Windows PowerShell modules
 * loaded by C:\Run\Prompt.ps1), delete the remote copy and wipe the local key.
 *
 * The private key never appears in a result, a preview or a command line (only `-i <path>`).
 * Scripts report a machine-readable result on one line: `[MCP_RESULT] {json}`.
 */
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runProcess, scpClientOpts, sshClientOpts } from "./runTests.js";
import { ensureCosmoSsh, } from "../cosmo/ssh.js";
import { redactCosmoText } from "../cosmo/client.js";
export const RESULT_MARKER = "[MCP_RESULT]";
export function escPs(s) {
    return s.replace(/'/g, "''");
}
function truncate(s, max = 6000) {
    if (s.length <= max)
        return s;
    return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}
/** Last `[MCP_RESULT] {json}` line of the remote output, parsed. */
export function extractResult(stdout) {
    const lines = stdout.split(/\r?\n/).filter((l) => l.includes(RESULT_MARKER));
    for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i].slice(lines[i].indexOf(RESULT_MARKER) + RESULT_MARKER.length).trim();
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object")
                return parsed;
        }
        catch {
            /* try the previous one */
        }
    }
    return undefined;
}
/**
 * Common preamble: load the NAV management cmdlets and resolve the server instance.
 * `Emit` writes the result marker line.
 */
export const PS_PREAMBLE = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "if (Test-Path 'C:\\Run\\Prompt.ps1') { . 'C:\\Run\\Prompt.ps1' | Out-Null }",
    "function Emit($obj) { Write-Output ('[MCP_RESULT] ' + ($obj | ConvertTo-Json -Compress -Depth 6)) }",
    "if (-not (Get-Command Get-NAVAppInfo -ErrorAction SilentlyContinue)) {",
    "  Emit @{ ok = $false; error = 'NAV management cmdlets not available in the container (C:\\Run\\Prompt.ps1 missing?).' }; exit 3",
    "}",
    "$si = $null",
    "if (Get-Command Get-NAVServerInstance -ErrorAction SilentlyContinue) {",
    "  $inst = Get-NAVServerInstance | Select-Object -First 1",
    "  if ($inst) { $si = ($inst.ServerInstance -replace '^.*\\$', '') }",
    "}",
    "if (-not $si) { $si = 'BC' }",
];
export async function runContainerScript(containerId, script, opts, deps = {}) {
    const run = deps.run ?? runProcess;
    const ensure = deps.ensure ?? ensureCosmoSsh;
    const start = Date.now();
    const ensured = await ensure(containerId, {
        waitSeconds: opts.sshWaitSeconds,
        allowRestart: opts.allowRestart,
    });
    const sshEnsure = ensured.result.steps.length > 1 ? ensured.result : undefined;
    const ssh = ensured.info;
    if (!ensured.result.ready || !ssh?.ipAddress || !ssh.privateKey) {
        return {
            ok: false,
            exitCode: null,
            durationMs: Date.now() - start,
            error: ensured.result.error ?? "Cosmo SSH is not usable (need ipAddress + privateKey).",
            hint: ensured.result.hint ??
                "Run cosmo_ensure_ssh for the container (allowRestart=true permits Stop → Start), then retry.",
            sshEnsure: ensured.result,
        };
    }
    const label = opts.label.replace(/[^a-z0-9-]/gi, "").slice(0, 24) || "script";
    const dir = mkdtempSync(join(tmpdir(), "origo-bc-ssh-"));
    const keyPath = join(dir, "cosmo_ssh_key");
    const localScript = join(dir, `${label}.ps1`);
    const remoteId = randomBytes(8).toString("hex");
    const remoteWin = `C:\\Windows\\Temp\\origo-bc-${label}-${remoteId}.ps1`;
    const remoteScp = `C:/Windows/Temp/origo-bc-${label}-${remoteId}.ps1`;
    const port = ssh.port || "22";
    const user = opts.sshUser?.trim() || process.env.COSMO_SSH_USER?.trim() || "sshuser";
    const target = `${user}@${ssh.ipAddress}`;
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const commandPreview = `scp -i <key> -P ${port} ${label}.ps1 ${target}:${remoteScp} && ` +
        `ssh -i <key> -p ${port} ${target} powershell.exe -NoProfile -File ${remoteWin}`;
    try {
        writeFileSync(keyPath, ssh.privateKey.endsWith("\n") ? ssh.privateKey : ssh.privateKey + "\n", {
            encoding: "utf8",
            mode: 0o600,
        });
        try {
            chmodSync(keyPath, 0o600);
        }
        catch {
            /* windows */
        }
        writeFileSync(localScript, script.replace(/\r?\n/g, "\r\n"), "utf8");
        const sshOpts = sshClientOpts(keyPath, port);
        const scpOpts = scpClientOpts(keyPath, port);
        const up = await run("scp", [...scpOpts, localScript, `${target}:${remoteScp}`], {
            timeoutMs: Math.min(timeoutMs, 60_000),
        });
        if (up.exitCode !== 0) {
            return {
                ok: false,
                exitCode: up.exitCode,
                durationMs: Date.now() - start,
                stderrPreview: truncate(redactCosmoText(up.stderr), 2000),
                commandPreview,
                error: `scp of the ${label} script to the container failed.`,
                hint: "Check cosmo_ssh_info / cosmo_ensure_ssh for the container, then retry.",
                ...(sshEnsure ? { sshEnsure } : {}),
            };
        }
        const proc = await run("ssh", [...sshOpts, target, "powershell.exe", "-NoProfile", "-File", remoteWin], {
            timeoutMs,
        });
        try {
            await run("ssh", [
                ...sshOpts,
                target,
                "powershell.exe",
                "-NoProfile",
                "-Command",
                `Remove-Item -LiteralPath '${escPs(remoteWin)}' -Force -ErrorAction SilentlyContinue`,
            ], { timeoutMs: 15_000 });
        }
        catch {
            /* best effort */
        }
        const result = extractResult(proc.stdout);
        const ok = proc.exitCode === 0 && result?.ok !== false;
        const resultError = typeof result?.error === "string" ? result.error : undefined;
        return {
            ok,
            exitCode: proc.exitCode,
            durationMs: Date.now() - start,
            ...(result ? { result } : {}),
            stdoutPreview: truncate(redactCosmoText(proc.stdout)),
            stderrPreview: proc.stderr ? truncate(redactCosmoText(proc.stderr), 3000) : undefined,
            commandPreview,
            ...(ok ? {} : { error: resultError ?? `Remote ${label} script exited with ${proc.exitCode}.` }),
            ...(sshEnsure ? { sshEnsure } : {}),
        };
    }
    finally {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch {
            /* best effort: key material */
        }
    }
}
//# sourceMappingURL=containerScript.js.map