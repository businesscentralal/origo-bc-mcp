/**
 * bc_dev_run_tests — run AL unit tests against a connected BC container.
 *
 * Preferred path (Cosmo): GET /Container/Ssh/{id}; SSH is usable when
 * ipAddress AND privateKey are present (do NOT require available===true —
 * available=false is expected while the container is Starting after Stop→Start).
 * SSH as sshuser with privateKey; scp local run-tests.ps1 to a remote temp path,
 * then `pwsh -NoProfile -File <remote>` (fallback: powershell.exe -File).
 * Do NOT pipe the script on stdin to `pwsh -Command -` (Cosmo Windows aborts
 * after the first Write-Host). Never log/echo the privateKey.
 *
 * When ip/key missing: return a clear error (do NOT silently fall back) with
 * Stop→Start recreate + create-with-sshEnabled=true hints. Retry briefly on
 * connect failure while the container is still Starting.
 *
 * Cosmo OpenAPI (Alpaca release) has NO /Container/Exec/{id}/… test runner —
 * only deployApp, appinfo, restartServerInstance, backup, dllCollection,
 * eventlog, prepareForBaseApp. mode=helper is explicit local-docker only.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cosmoRequest } from "../cosmo/client.js";
const COSMO_EXEC_TEST_NOTE = "Cosmo Alpaca OpenAPI has no /Container/Exec/{id} test-runner endpoint " +
    "(only deployApp, appinfo, restartServerInstance, backup, dllCollection, eventlog, prepareForBaseApp). " +
    "AL unit tests require SSH (Invoke-NavContainerTests / Run-TestsInBcContainer / Run-AlTests).";
const SSH_UNAVAILABLE_HINT = "Cosmo SSH credentials missing (need ipAddress + privateKey from cosmo_ssh_info). " +
    "Note: available=false during Starting is normal after Stop→Start — usable SSH is keyed off ip+privateKey, not available===true. " +
    "If both are absent: (1) cosmo_update_container state=Stop, then state=Start (or delete + cosmo_create_container with sshEnabled=true), " +
    "(2) re-check cosmo_ssh_info until ipAddress and privateKey are present, " +
    "(3) retry bc_dev_run_tests. Standing bc28-is-grok may need a fresh create-with-sshEnabled=true. " +
    COSMO_EXEC_TEST_NOTE;
function truncate(s, max = 8000) {
    if (s.length <= max)
        return s;
    return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}
function escPs(s) {
    return s.replace(/'/g, "''");
}
function resolveSshUser(input) {
    return (input.sshUser?.trim() ||
        process.env.COSMO_SSH_USER?.trim() ||
        "sshuser");
}
export function parseJunit(xml) {
    const tests = Number(xml.match(/\btests="(\d+)"/)?.[1] ?? 0);
    const failuresN = Number(xml.match(/\bfailures="(\d+)"/)?.[1] ?? 0);
    const errorsN = Number(xml.match(/\berrors="(\d+)"/)?.[1] ?? 0);
    const skippedN = Number(xml.match(/\bskipped="(\d+)"/)?.[1] ?? 0);
    const failures = [];
    // Prefer self-closing testcase so attrs never swallow the trailing "/"
    const caseRe = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
    let m;
    while ((m = caseRe.exec(xml)) !== null) {
        const attrs = m[1] ?? m[2] ?? "";
        const body = m[3] ?? "";
        const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? "(unknown)";
        const classname = attrs.match(/\bclassname="([^"]*)"/)?.[1];
        const fail = body.match(/<(?:failure|error)\b[^>]*message="([^"]*)"[^>]*(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/);
        if (fail) {
            const message = (fail[1] || fail[2] || "failed").trim().slice(0, 500);
            failures.push({ name, message, classname });
        }
    }
    const failed = failuresN + errorsN;
    const passed = Math.max(0, tests - failed - skippedN);
    return { passed, failed, skipped: skippedN, errors: errorsN, failures: failures.slice(0, 50) };
}
/** Parse BcContainerHelper / AL test console lines into counts + failure messages. */
export function parseConsoleSummary(text) {
    const failures = [];
    const failLine = /(?:Failed|Error)\s*[:\-]\s*(.+?)(?:\r?\n|$)/gi;
    let m;
    while ((m = failLine.exec(text)) !== null && failures.length < 50) {
        failures.push({ name: m[1].trim().slice(0, 200), message: m[1].trim().slice(0, 500) });
    }
    const passed = Number(text.match(/\bPassed\s*[:=]\s*(\d+)/i)?.[1]) ||
        Number(text.match(/\b(\d+)\s+passed\b/i)?.[1]) ||
        undefined;
    const failed = Number(text.match(/\bFailed\s*[:=]\s*(\d+)/i)?.[1]) ||
        Number(text.match(/\b(\d+)\s+failed\b/i)?.[1]) ||
        (failures.length || undefined);
    const skipped = Number(text.match(/\bSkipped\s*[:=]\s*(\d+)/i)?.[1]) ||
        Number(text.match(/\b(\d+)\s+skipped\b/i)?.[1]) ||
        undefined;
    return { passed, failed, skipped, failures };
}
function runProcess(command, args, opts) {
    const start = Date.now();
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            env: { ...process.env, ...opts.env },
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            try {
                child.kill("SIGTERM");
            }
            catch {
                /* ignore */
            }
            stderr += `\n[MCP] timed out after ${opts.timeoutMs}ms\n`;
        }, opts.timeoutMs);
        child.stdout?.on("data", (b) => {
            stdout += b.toString("utf8");
        });
        child.stderr?.on("data", (b) => {
            stderr += b.toString("utf8");
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - start });
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({
                exitCode: 1,
                stdout,
                stderr: `${stderr}\n${err.message}`,
                durationMs: Date.now() - start,
            });
        });
    });
}
export function normalizeSshInfo(body, httpStatus) {
    const obj = body && typeof body === "object" ? body : {};
    const available = obj.available === true;
    const ipAddress = typeof obj.ipAddress === "string"
        ? obj.ipAddress
        : typeof obj.host === "string"
            ? obj.host
            : undefined;
    const port = obj.port !== undefined && obj.port !== null ? String(obj.port) : undefined;
    const privateKey = typeof obj.privateKey === "string"
        ? obj.privateKey
        : typeof obj.PrivateKey === "string"
            ? obj.PrivateKey
            : undefined;
    return {
        available,
        ipAddress: ipAddress?.trim() || undefined,
        port: port?.trim() || undefined,
        privateKey: privateKey?.trim() || undefined,
        httpStatus,
        rawKeys: Object.keys(obj),
    };
}
export async function fetchCosmoSshInfo(containerId) {
    const res = await cosmoRequest("GET", `/Container/Ssh/${encodeURIComponent(containerId)}`);
    return normalizeSshInfo(res.body, res.status);
}
function buildRemoteTestScript(input, conn) {
    const company = input.companyName?.trim() || conn.companyName?.trim() || "CRONUS IS";
    const tenant = input.tenant?.trim() || conn.onPremTenant || "default";
    const suite = input.testSuite?.trim() || "DEFAULT";
    const user = conn.user || "";
    const pass = conn.key || "";
    const lines = [
        "$ErrorActionPreference = 'Continue'",
        "Write-Host '[MCP] bc_dev_run_tests remote start'",
        `$companyName = '${escPs(company)}'`,
        `$tenant = '${escPs(tenant)}'`,
        `$testSuite = '${escPs(suite)}'`,
        `$extensionId = '${escPs(input.extensionId || "")}'`,
        `$testCodeunit = '${escPs(input.testCodeunit || "")}'`,
        `$testFunction = '${escPs(input.testFunction || "")}'`,
        `$user = '${escPs(user)}'`,
        `$passPlain = '${escPs(pass)}'`,
        `$cred = $null`,
        `if ($user -and $passPlain) { $cred = New-Object pscredential($user, (ConvertTo-SecureString $passPlain -AsPlainText -Force)) }`,
        `$junit = Join-Path $env:TEMP ('mcp-al-tests-' + [guid]::NewGuid().ToString() + '.xml')`,
        `# Prefer documented helpers in order`,
        `$cmd = $null`,
        `foreach ($name in @('Invoke-NavContainerTests','Run-TestsInBcContainer','Run-AlTests','Invoke-ALTests')) {`,
        `  if (Get-Command $name -ErrorAction SilentlyContinue) { $cmd = $name; break }`,
        `  if (Get-Module -ListAvailable BcContainerHelper) { Import-Module BcContainerHelper -ErrorAction SilentlyContinue; if (Get-Command $name -ErrorAction SilentlyContinue) { $cmd = $name; break } }`,
        `}`,
        `if (-not $cmd) {`,
        `  Write-Host '[MCP] No Invoke-NavContainerTests / Run-TestsInBcContainer / Run-AlTests on SSH host.'`,
        `  Get-Command *Test* -ErrorAction SilentlyContinue | Select-Object -First 30 | Format-Table -AutoSize | Out-String | Write-Host`,
        `  exit 3`,
        `}`,
        `Write-Host "[MCP] Using $cmd"`,
        `$params = @{ detailed = $true; returnTrueIfAllPassed = $true }`,
        `if ($cred) { $params.credential = $cred }`,
        `if ($tenant) { $params.tenant = $tenant }`,
        `if ($companyName) { $params.companyName = $companyName }`,
        `if ($testSuite) { $params.testSuite = $testSuite }`,
        `if ($extensionId) { $params.extensionId = $extensionId }`,
        `if ($testCodeunit) { $params.testCodeunit = $testCodeunit }`,
        `if ($testFunction) { $params.testFunction = $testFunction }`,
        `try { $params.JUnitResultFileName = $junit } catch { }`,
        `# Inside Cosmo SSH we are already on the container host; containerName often = hostname`,
        `if ($cmd -eq 'Run-TestsInBcContainer' -or $cmd -eq 'Invoke-NavContainerTests') {`,
        `  $cn = $env:COMPUTERNAME`,
        `  if (Get-BCContainer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $cn }) { $params.containerName = $cn }`,
        `  elseif (docker ps --format '{{.Names}}' 2>$null | Select-Object -First 1) { $params.containerName = (docker ps --format '{{.Names}}' | Select-Object -First 1) }`,
        `}`,
        `$allPassed = & $cmd @params`,
        `if (Test-Path $junit) { Write-Host "[MCP_JUNIT_BEGIN]"; Get-Content -Raw $junit; Write-Host "[MCP_JUNIT_END]" }`,
        `if ($allPassed -eq $false) { Write-Host '[MCP] Some tests failed'; exit 2 }`,
        `Write-Host '[MCP] Tests finished'; exit 0`,
    ];
    return lines.join("\n");
}
function extractJunitFromStdout(stdout) {
    const m = stdout.match(/\[MCP_JUNIT_BEGIN\]\r?\n([\s\S]*?)\r?\n\[MCP_JUNIT_END\]/);
    return m?.[1];
}
/** Shared OpenSSH client options (never includes privateKey material). */
export function sshClientOpts(keyPath, port) {
    return [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=8",
        "-p",
        port,
    ];
}
/** Remote temp path for the uploaded run-tests.ps1 (Windows Cosmo host). */
export function remoteRunTestsPath(id) {
    const name = `origo-bc-run-tests-${id}.ps1`;
    return {
        winPath: `C:\\Windows\\Temp\\${name}`,
        // scp on OpenSSH for Windows accepts forward-slash destinations reliably
        scpPath: `C:/Windows/Temp/${name}`,
    };
}
function looksLikeMissingShell(shell, stdout, stderr, exitCode) {
    const blob = `${stdout}\n${stderr}`;
    if (exitCode === 127)
        return true;
    const re = new RegExp(`(?:${shell}.*(?:not (?:found|recognized)|No such file|CommandNotFoundException)|` +
        `'${shell}' is not recognized|The term '${shell}' is not recognized)`, "i");
    return re.test(blob);
}
async function runViaSsh(input, conn, ssh) {
    if (!ssh.ipAddress || !ssh.privateKey) {
        return {
            ok: false,
            mode: "blocked",
            exitCode: 1,
            durationMs: 0,
            ssh: { available: ssh.available, ipAddress: ssh.ipAddress, port: ssh.port, httpStatus: ssh.httpStatus },
            cosmoExecTestEndpoint: "none",
            error: "cosmo_ssh_info missing ipAddress and/or privateKey (required for SSH). Keys: " +
                ssh.rawKeys.join(", "),
            hint: SSH_UNAVAILABLE_HINT,
        };
    }
    const dir = mkdtempSync(join(tmpdir(), "origo-bc-run-tests-"));
    const keyPath = join(dir, "cosmo_ssh_key");
    const scriptPath = join(dir, "run-tests.ps1");
    const remoteScript = buildRemoteTestScript(input, conn);
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
    writeFileSync(scriptPath, remoteScript, "utf8");
    const user = resolveSshUser(input);
    const port = ssh.port || "22";
    const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
    const target = `${user}@${ssh.ipAddress}`;
    const remoteId = randomBytes(8).toString("hex");
    const { winPath: remoteWinPath, scpPath: remoteScpPath } = remoteRunTestsPath(remoteId);
    const commandPreview = `scp -i <key> -P ${port} run-tests.ps1 ${target}:${remoteScpPath} && ` +
        `ssh -i <key> -p ${port} ${target} pwsh|powershell -NoProfile -File ${remoteWinPath}` +
        `  # extensionId=${input.extensionId ?? ""}`;
    const sshOpts = sshClientOpts(keyPath, port);
    // scp uses -P for port; strip ssh's -p and rebuild
    const scpOpts = [
        "-i",
        keyPath,
        "-P",
        port,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=8",
    ];
    const wipeLocal = () => {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch {
            /* ignore — key material best-effort wipe */
        }
    };
    const scpTimeout = Math.min(timeoutMs, 60_000);
    const scpProc = await runProcess("scp", [...scpOpts, scriptPath, `${target}:${remoteScpPath}`], { timeoutMs: scpTimeout });
    if (scpProc.exitCode !== 0) {
        wipeLocal();
        return {
            ok: false,
            mode: "ssh",
            exitCode: scpProc.exitCode,
            durationMs: scpProc.durationMs,
            ssh: {
                available: ssh.available,
                ipAddress: ssh.ipAddress,
                port,
                httpStatus: ssh.httpStatus,
            },
            cosmoExecTestEndpoint: "none",
            stdoutPreview: truncate(scpProc.stdout),
            stderrPreview: truncate(scpProc.stderr),
            commandPreview,
            error: "scp of run-tests.ps1 to Cosmo SSH host failed",
            hint: "Ensure OpenSSH scp works to the container (ip+privateKey), then retry. " +
                "Do not pipe scripts via pwsh -Command - over SSH on Cosmo Windows hosts.",
        };
    }
    const invokeRemote = (shell) => runProcess("ssh", [...sshOpts, target, shell, "-NoProfile", "-File", remoteWinPath], {
        timeoutMs,
    });
    let proc = await invokeRemote("pwsh");
    let shellUsed = "pwsh";
    if (looksLikeMissingShell("pwsh", proc.stdout, proc.stderr, proc.exitCode)) {
        proc = await invokeRemote("powershell.exe");
        shellUsed = "powershell.exe";
    }
    // Best-effort remote delete of uploaded script (never log key).
    const delPs = `Remove-Item -LiteralPath '${remoteWinPath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`;
    try {
        await runProcess("ssh", [...sshOpts, target, "powershell.exe", "-NoProfile", "-Command", delPs], { timeoutMs: 15_000 });
    }
    catch {
        /* ignore */
    }
    wipeLocal();
    const junitXml = extractJunitFromStdout(proc.stdout);
    let passed;
    let failed;
    let skipped;
    let errors;
    let failures = [];
    if (junitXml) {
        const parsed = parseJunit(junitXml);
        passed = parsed.passed;
        failed = parsed.failed;
        skipped = parsed.skipped;
        errors = parsed.errors;
        failures = parsed.failures;
    }
    else {
        const parsed = parseConsoleSummary(proc.stdout + "\n" + proc.stderr);
        passed = parsed.passed;
        failed = parsed.failed;
        skipped = parsed.skipped;
        failures = parsed.failures;
    }
    return {
        ok: proc.exitCode === 0,
        mode: "ssh",
        exitCode: proc.exitCode,
        durationMs: proc.durationMs,
        passed,
        failed,
        skipped,
        errors,
        failures: failures.length ? failures : undefined,
        ssh: {
            available: true,
            ipAddress: ssh.ipAddress,
            port,
            httpStatus: ssh.httpStatus,
        },
        cosmoExecTestEndpoint: "none",
        stdoutPreview: truncate(proc.stdout),
        stderrPreview: truncate((shellUsed !== "pwsh" ? `[MCP] remote shell=${shellUsed}\n` : "") + proc.stderr),
        commandPreview,
        hint: proc.exitCode === 0
            ? undefined
            : "SSH ran but tests did not all pass (or helper missing). Ensure Test Toolkit is installed and extensionId/companyName are correct.",
    };
}
async function runHelperLocal(input, conn) {
    const containerName = input.containerName?.trim();
    if (!containerName) {
        return {
            ok: false,
            mode: "helper",
            exitCode: 1,
            durationMs: 0,
            cosmoExecTestEndpoint: "none",
            error: "mode=helper requires containerName (local docker BC container). For Cosmo containers use mode=ssh/auto with containerId.",
            hint: SSH_UNAVAILABLE_HINT,
        };
    }
    if (!conn.user || !conn.key) {
        return {
            ok: false,
            mode: "helper",
            exitCode: 1,
            durationMs: 0,
            error: "Connection needs on-prem user/key (NavUserPassword) for test credentials.",
        };
    }
    const dir = mkdtempSync(join(tmpdir(), "origo-bc-helper-tests-"));
    const scriptPath = join(dir, "run-tests.ps1");
    const junitPath = join(dir, "results.junit.xml");
    const company = input.companyName?.trim() || conn.companyName?.trim() || "CRONUS IS";
    const tenant = input.tenant?.trim() || conn.onPremTenant || "default";
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "Import-Module BcContainerHelper -ErrorAction Stop",
        `$cred = New-Object pscredential('${escPs(conn.user)}', (ConvertTo-SecureString '${escPs(conn.key)}' -AsPlainText -Force))`,
        `$params = @{ containerName='${escPs(containerName)}'; credential=$cred; tenant='${escPs(tenant)}'; companyName='${escPs(company)}'; testSuite='${escPs(input.testSuite || "DEFAULT")}'; detailed=$true; returnTrueIfAllPassed=$true; JUnitResultFileName='${escPs(junitPath)}' }`,
        input.extensionId ? `$params.extensionId = '${escPs(input.extensionId)}'` : "",
        input.testCodeunit ? `$params.testCodeunit = '${escPs(input.testCodeunit)}'` : "",
        input.testFunction ? `$params.testFunction = '${escPs(input.testFunction)}'` : "",
        `$cmd = if (Get-Command Invoke-NavContainerTests -ErrorAction SilentlyContinue) { 'Invoke-NavContainerTests' } else { 'Run-TestsInBcContainer' }`,
        `Write-Host "[MCP] helper $cmd"`,
        `$allPassed = & $cmd @params`,
        `if (-not $allPassed) { exit 2 }`,
        `exit 0`,
    ]
        .filter(Boolean)
        .join("\n");
    writeFileSync(scriptPath, script, "utf8");
    const pwsh = process.env.MCP_PWSH_PATH?.trim() || (process.platform === "win32" ? "pwsh.exe" : "pwsh");
    const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
    const proc = await runProcess(pwsh, ["-NoProfile", "-File", scriptPath], { timeoutMs });
    let passed;
    let failed;
    let skipped;
    let errors;
    let failures;
    if (existsSync(junitPath)) {
        try {
            const parsed = parseJunit(readFileSync(junitPath, "utf8"));
            passed = parsed.passed;
            failed = parsed.failed;
            skipped = parsed.skipped;
            errors = parsed.errors;
            failures = parsed.failures;
        }
        catch {
            /* ignore */
        }
    }
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
    return {
        ok: proc.exitCode === 0,
        mode: "helper",
        exitCode: proc.exitCode,
        durationMs: proc.durationMs,
        passed,
        failed,
        skipped,
        errors,
        failures,
        cosmoExecTestEndpoint: "none",
        stdoutPreview: truncate(proc.stdout),
        stderrPreview: truncate(proc.stderr),
        commandPreview: `${pwsh} -File run-tests.ps1 # containerName=${containerName}`,
    };
}
export function sshUsable(ssh) {
    // Architect: after Stop→Start, available may stay false while Starting even when
    // ipAddress + RSA privateKey are already present. Gate on credentials, not available.
    return Boolean(ssh.ipAddress?.trim() && ssh.privateKey?.trim());
}
function sshBlockedResult(ssh) {
    return {
        ok: false,
        mode: "blocked",
        exitCode: 1,
        durationMs: 0,
        ssh: {
            available: ssh.available,
            ipAddress: ssh.ipAddress,
            port: ssh.port,
            httpStatus: ssh.httpStatus,
        },
        cosmoExecTestEndpoint: "none",
        error: "Cosmo SSH unusable — ipAddress and privateKey required (available flag ignored). " +
            `available=${ssh.available}; hasIp=${Boolean(ssh.ipAddress)}; hasKey=${Boolean(ssh.privateKey)}.`,
        hint: SSH_UNAVAILABLE_HINT,
    };
}
export async function runBcTests(input, conn) {
    const mode = input.mode || "auto";
    if (mode === "helper") {
        return runHelperLocal(input, conn);
    }
    const containerId = input.containerId?.trim();
    if (!containerId) {
        return {
            ok: false,
            mode: "blocked",
            exitCode: 1,
            durationMs: 0,
            cosmoExecTestEndpoint: "none",
            error: "containerId is required for Cosmo SSH test runs (mode=auto|ssh). For a local docker container use mode=helper + containerName.",
            hint: SSH_UNAVAILABLE_HINT,
        };
    }
    let ssh;
    try {
        ssh = await fetchCosmoSshInfo(containerId);
    }
    catch (err) {
        return {
            ok: false,
            mode: "blocked",
            exitCode: 1,
            durationMs: 0,
            cosmoExecTestEndpoint: "none",
            error: `cosmo_ssh_info failed: ${err instanceof Error ? err.message : String(err)}`,
            hint: SSH_UNAVAILABLE_HINT,
        };
    }
    if (ssh.httpStatus >= 400 || !sshUsable(ssh)) {
        return sshBlockedResult(ssh);
    }
    // Retry SSH connect briefly — container may still be Starting after Stop→Start.
    const attempts = Math.max(1, Number(process.env.BC_DEV_SSH_RETRIES || 4));
    const delayMs = Math.max(0, Number(process.env.BC_DEV_SSH_RETRY_MS || 8000));
    let last;
    for (let i = 0; i < attempts; i++) {
        last = await runViaSsh(input, conn, ssh);
        if (last.ok)
            return last;
        const connectFail = /Connection refused|Connection timed out|No route to host|Connection reset|Permission denied|timed out after/i.test(`${last.stderrPreview || ""}
${last.stdoutPreview || ""}
${last.error || ""}`);
        if (!connectFail || i === attempts - 1)
            return last;
        await new Promise((r) => setTimeout(r, delayMs));
        // Refresh SSH info in case port/ip rotated while Starting
        try {
            ssh = await fetchCosmoSshInfo(containerId);
            if (!sshUsable(ssh))
                return sshBlockedResult(ssh);
        }
        catch {
            /* keep prior ssh */
        }
    }
    return last;
}
//# sourceMappingURL=runTests.js.map