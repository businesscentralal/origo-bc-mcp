/**
 * bc_dev_run_tests — run AL unit tests against a connected BC container.
 *
 * Preferred path (Cosmo): GET /Container/Ssh/{id}; SSH is usable when
 * ipAddress AND privateKey are present (do NOT require available===true —
 * available=false is expected while the container is Starting after Stop→Start).
 * SSH as sshuser with privateKey; scp local run-tests.ps1 (+ vendored
 * PsTestFunctions.ps1 / ClientContext.ps1) to a remote temp path, then
 * `pwsh -NoProfile -File <remote>` (fallback: powershell.exe -File).
 * Do NOT pipe the script on stdin to `pwsh -Command -` (Cosmo Windows aborts
 * after the first Write-Host). Never log/echo the privateKey.
 *
 * Cosmo SSH lands **inside** the BC container (sshuser), not on a Docker host.
 * Host-side BcContainerHelper cmdlets (Invoke-NavContainerTests /
 * Run-TestsInBcContainer / Run-AlTests) are usually absent. When missing, the
 * remote script uses the **in-container Client Services** path (same approach
 * Run-TestsInBcContainer uses *inside* the container): Prompt.ps1, local NST
 * Client Services URL, New-ClientContext + Run-Tests from PsTestFunctions.
 * Option B (BC 27.5+/28): CLI Test Runner codeunit 130201 via Invoke-NAVCodeunit
 * if page 130455 is gone.
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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { cosmoRequest } from "../cosmo/client.js";
const COSMO_EXEC_TEST_NOTE = "Cosmo Alpaca OpenAPI has no /Container/Exec/{id} test-runner endpoint " +
    "(only deployApp, appinfo, restartServerInstance, backup, dllCollection, eventlog, prepareForBaseApp). " +
    "AL unit tests require SSH into the BC container; Cosmo SSH is in-container (Client Services / " +
    "PsTestFunctions), not host-side BcContainerHelper.";
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
/** Known AL test-tool page / codeunit ids — never treat as failure counts. */
const KNOWN_TEST_TOOL_IDS = new Set([
    "130455",
    "130202",
    "130203",
    "130409",
    "130201",
]);
function isBareTestToolId(s) {
    return KNOWN_TEST_TOOL_IDS.has(s.trim());
}
/** Parse BcContainerHelper / AL test console lines into counts + failure messages. */
export function parseConsoleSummary(text) {
    const failures = [];
    for (const line of text.split(/\r?\n/)) {
        // MCP diagnostics like "[MCP] testPage 130455 failed: ..." are not test failures.
        if (/\[MCP\].*\btestPage\b/i.test(line))
            continue;
        const m = /(?:^|[\s])(?:Failed|Error)\s*[:\-]\s*(.+?)$/i.exec(line);
        if (!m)
            continue;
        const raw = m[1].trim();
        if (!raw || isBareTestToolId(raw))
            continue;
        // "Failed: 1" summary lines are counts, not named failures
        if (/^\d+$/.test(raw))
            continue;
        failures.push({ name: raw.slice(0, 200), message: raw.slice(0, 500) });
        if (failures.length >= 50)
            break;
    }
    const passed = Number(text.match(/\bPassed\s*[:=]\s*(\d+)/i)?.[1]) ||
        Number(text.match(/\b(\d+)\s+passed\b/i)?.[1]) ||
        undefined;
    const failedExplicit = Number(text.match(/\bFailed\s*[:=]\s*(\d+)/i)?.[1]) || undefined;
    // Avoid "testPage 130455 failed" → failed=130455 via \b(\d+)\s+failed\b
    let failedLoose;
    const looseRe = /\b(\d+)\s+failed\b/gi;
    let lm;
    while ((lm = looseRe.exec(text)) !== null) {
        const n = Number(lm[1]);
        const id = String(lm[1]);
        if (KNOWN_TEST_TOOL_IDS.has(id) || n >= 10_000)
            continue;
        // Prefer a count that appears as a summary, not a page id
        failedLoose = n;
        break;
    }
    const failed = failedExplicit || failedLoose || (failures.length || undefined);
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
/** Resolve vendored PsTestFunctions + ClientContext next to compiled JS (or src checkout). */
export function resolvePsTestHelperPaths() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, "pstest"),
        join(here, "..", "..", "src", "bc", "pstest"),
        join(process.cwd(), "src", "bc", "pstest"),
        join(process.cwd(), "dist", "bc", "pstest"),
    ];
    for (const dir of candidates) {
        const ps = join(dir, "PsTestFunctions.ps1");
        const cc = join(dir, "ClientContext.ps1");
        if (existsSync(ps) && existsSync(cc)) {
            return { psTestFunctions: ps, clientContext: cc };
        }
    }
    return {};
}
/**
 * Remote PowerShell for Cosmo SSH (inside BC container).
 * Prefer host helpers if present; else in-container Client Services / PsTestFunctions.
 */
export function buildRemoteTestScript(input, conn, opts) {
    const company = input.companyName?.trim() || conn.companyName?.trim() || "CRONUS IS";
    const tenant = input.tenant?.trim() || conn.onPremTenant || "default";
    const suite = input.testSuite?.trim() || "DEFAULT";
    const user = conn.user || "";
    const pass = conn.key || "";
    const remotePs = opts?.remotePsTestFunctions || "";
    const remoteCc = opts?.remoteClientContext || "";
    const lines = [
        "$ErrorActionPreference = 'Continue'",
        "Write-Host '[MCP] bc_dev_run_tests remote start'",
        "Write-Host '[MCP] Cosmo SSH is typically inside the BC container (not a Docker host).'",
        `$companyName = '${escPs(company)}'`,
        `$tenant = '${escPs(tenant)}'`,
        `$testSuite = '${escPs(suite)}'`,
        `$extensionId = '${escPs(input.extensionId || "")}'`,
        `$testCodeunit = '${escPs(input.testCodeunit || "")}'`,
        `$testFunction = '${escPs(input.testFunction || "")}'`,
        `$user = '${escPs(user)}'`,
        `$passPlain = '${escPs(pass)}'`,
        `$uploadedPsTest = '${escPs(remotePs)}'`,
        `$uploadedClientCtx = '${escPs(remoteCc)}'`,
        `$cred = $null`,
        `if ($user -and $passPlain) { $cred = New-Object pscredential($user, (ConvertTo-SecureString $passPlain -AsPlainText -Force)) }`,
        `$junit = Join-Path $env:TEMP ('mcp-al-tests-' + [guid]::NewGuid().ToString() + '.xml')`,
        `# Load container NAV Management if present (Cosmo in-container)`,
        `if (Test-Path 'C:\\Run\\Prompt.ps1') {`,
        `  Write-Host '[MCP] Dot-sourcing C:\\Run\\Prompt.ps1'`,
        `  . 'C:\\Run\\Prompt.ps1'`,
        `}`,
        `# --- Path 1: host-side BcContainerHelper cmdlets (rare on Cosmo SSH) ---`,
        `$cmd = $null`,
        `foreach ($name in @('Invoke-NavContainerTests','Run-TestsInBcContainer','Run-AlTests','Invoke-ALTests')) {`,
        `  if (Get-Command $name -ErrorAction SilentlyContinue) { $cmd = $name; break }`,
        `  if (Get-Module -ListAvailable BcContainerHelper) { Import-Module BcContainerHelper -ErrorAction SilentlyContinue; if (Get-Command $name -ErrorAction SilentlyContinue) { $cmd = $name; break } }`,
        `}`,
        `if ($cmd) {`,
        `  Write-Host "[MCP] Using host helper $cmd"`,
        `  $params = @{ detailed = $true; returnTrueIfAllPassed = $true }`,
        `  if ($cred) { $params.credential = $cred }`,
        `  if ($tenant) { $params.tenant = $tenant }`,
        `  if ($companyName) { $params.companyName = $companyName }`,
        `  if ($testSuite) { $params.testSuite = $testSuite }`,
        `  if ($extensionId) { $params.extensionId = $extensionId }`,
        `  if ($testCodeunit) { $params.testCodeunit = $testCodeunit }`,
        `  if ($testFunction) { $params.testFunction = $testFunction }`,
        `  try { $params.JUnitResultFileName = $junit } catch { }`,
        `  if ($cmd -eq 'Run-TestsInBcContainer' -or $cmd -eq 'Invoke-NavContainerTests') {`,
        `    $cn = $env:COMPUTERNAME`,
        `    if (Get-Command Get-BCContainer -ErrorAction SilentlyContinue) {`,
        `      if (Get-BCContainer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $cn }) { $params.containerName = $cn }`,
        `    }`,
        `    elseif (Get-Command docker -ErrorAction SilentlyContinue) {`,
        `      $dn = docker ps --format '{{.Names}}' 2>$null | Select-Object -First 1`,
        `      if ($dn) { $params.containerName = $dn }`,
        `    }`,
        `  }`,
        `  $allPassed = & $cmd @params`,
        `  if (Test-Path $junit) { Write-Host "[MCP_JUNIT_BEGIN]"; Get-Content -Raw $junit; Write-Host "[MCP_JUNIT_END]" }`,
        `  if ($allPassed -eq $false) { Write-Host '[MCP] Some tests failed'; exit 2 }`,
        `  Write-Host '[MCP] Tests finished (host helper)'; exit 0`,
        `}`,
        `Write-Host '[MCP] No Invoke-NavContainerTests / Run-TestsInBcContainer / Run-AlTests on SSH host — using in-container Client Services path.'`,
        `# --- Path 2 (Option A): Client Services + PsTestFunctions (inside container) ---`,
        `function Get-McpPsTestScripts {`,
        `  $dest = Join-Path $env:TEMP ('mcp-pstest-' + [guid]::NewGuid().ToString())`,
        `  New-Item -ItemType Directory -Path $dest -Force | Out-Null`,
        `  $psDest = Join-Path $dest 'PsTestFunctions.ps1'`,
        `  $ccDest = Join-Path $dest 'ClientContext.ps1'`,
        `  if ($uploadedPsTest -and $uploadedClientCtx -and (Test-Path $uploadedPsTest) -and (Test-Path $uploadedClientCtx)) {`,
        `    Copy-Item -Force $uploadedPsTest $psDest`,
        `    Copy-Item -Force $uploadedClientCtx $ccDest`,
        `    Write-Host '[MCP] Using scp-uploaded PsTestFunctions + ClientContext'`,
        `    return @{ Ps = $psDest; Cc = $ccDest; Dir = $dest }`,
        `  }`,
        `  Write-Host '[MCP] Install-Module BcContainerHelper -Force (extract PsTestFunctions)'`,
        `  try {`,
        `    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -ErrorAction SilentlyContinue | Out-Null`,
        `    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue`,
        `    Install-Module BcContainerHelper -Force -Scope CurrentUser -AllowClobber -ErrorAction Stop`,
        `  } catch {`,
        `    Write-Host "[MCP] Install-Module BcContainerHelper failed: $($_.Exception.Message)"`,
        `  }`,
        `  $mod = Get-Module -ListAvailable BcContainerHelper | Sort-Object Version -Descending | Select-Object -First 1`,
        `  if (-not $mod) { return $null }`,
        `  $root = Split-Path -Parent $mod.Path`,
        `  $candidates = @(`,
        `    (Join-Path $root 'AppHandling\\PsTestFunctions.ps1'),`,
        `    (Join-Path $root 'PsTestFunctions.ps1')`,
        `  )`,
        `  $psSrc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1`,
        `  $ccSrc = @(`,
        `    (Join-Path $root 'AppHandling\\ClientContext.ps1'),`,
        `    (Join-Path $root 'ClientContext.ps1')`,
        `  ) | Where-Object { Test-Path $_ } | Select-Object -First 1`,
        `  if (-not $psSrc -or -not $ccSrc) {`,
        `    Write-Host "[MCP] BcContainerHelper at $root but PsTestFunctions/ClientContext not found"`,
        `    return $null`,
        `  }`,
        `  Copy-Item -Force $psSrc $psDest`,
        `  Copy-Item -Force $ccSrc $ccDest`,
        `  Write-Host "[MCP] Extracted PsTestFunctions from BcContainerHelper $($mod.Version)"`,
        `  return @{ Ps = $psDest; Cc = $ccDest; Dir = $dest }`,
        `}`,
        `$scripts = Get-McpPsTestScripts`,
        `$clientServicesOk = $false`,
        `$lastCsError = ''`,
        `if ($scripts) {`,
        `  try {`,
        `    $serviceItem = Get-Item 'C:\\Program Files\\Microsoft Dynamics NAV\\*\\Service' -ErrorAction Stop | Select-Object -First 1`,
        `    $serviceDir = $serviceItem.FullName`,
        `    $newton = Join-Path $serviceDir 'Management\\Newtonsoft.Json.dll'`,
        `    if (-not (Test-Path $newton)) { $newton = Join-Path $serviceDir 'Newtonsoft.Json.dll' }`,
        `    $newton = (Get-Item $newton -ErrorAction Stop).FullName`,
        `    $clientDll = 'C:\\Test Assemblies\\Microsoft.Dynamics.Framework.UI.Client.dll'`,
        `    if (-not (Test-Path $clientDll)) {`,
        `      $alt = Get-ChildItem 'C:\\Program Files\\Microsoft Dynamics NAV' -Recurse -Filter 'Microsoft.Dynamics.Framework.UI.Client.dll' -ErrorAction SilentlyContinue | Select-Object -First 1`,
        `      if ($alt) { $clientDll = $alt.FullName }`,
        `    }`,
        `    if (-not (Test-Path $clientDll)) { throw "Microsoft.Dynamics.Framework.UI.Client.dll not found (expected under C:\\Test Assemblies)" }`,
        `    $customConfigFile = Join-Path $serviceDir 'CustomSettings.config'`,
        `    [xml]$customConfig = [System.IO.File]::ReadAllText($customConfigFile)`,
        `    $publicWebBaseUrl = $customConfig.SelectSingleNode("//appSettings/add[@key='PublicWebBaseUrl']").Value.TrimEnd('/')`,
        `    $authType = $customConfig.SelectSingleNode("//appSettings/add[@key='ClientServicesCredentialType']").Value`,
        `    if (-not $authType) { $authType = 'NavUserPassword' }`,
        `    $uri = [Uri]::new($publicWebBaseUrl)`,
        `    $csPortNode = $customConfig.SelectSingleNode("//appSettings/add[@key='ClientServicesPort']")`,
        `    $csPort = if ($csPortNode -and $csPortNode.Value) { $csPortNode.Value } else { $uri.Port }`,
        `    $pathBase = $uri.AbsolutePath.TrimEnd('/')`,
        `    # Prefer https://localhost (Cosmo usessl=y) after trust-any; also try without company query.`,
        `    $serviceUrls = New-Object System.Collections.Generic.List[string]`,
        `    $httpsWithCompany = "https://localhost:$($uri.Port)$pathBase/cs?tenant=$tenant"`,
        `    if ($companyName) { $httpsWithCompany += "&company=$([Uri]::EscapeDataString($companyName))" }`,
        `    [void]$serviceUrls.Add($httpsWithCompany)`,
        `    $httpsNoCompany = "https://localhost:$($uri.Port)$pathBase/cs?tenant=$tenant"`,
        `    if ($httpsNoCompany -ne $httpsWithCompany) { [void]$serviceUrls.Add($httpsNoCompany) }`,
        `    if ($uri.Scheme -eq 'https' -or [int]$csPort -ne [int]$uri.Port) {`,
        `      $httpAlt = "http://localhost:$csPort$pathBase/cs?tenant=$tenant"`,
        `      if ($companyName) { $httpAlt += "&company=$([Uri]::EscapeDataString($companyName))" }`,
        `      if (-not $serviceUrls.Contains($httpAlt)) { [void]$serviceUrls.Add($httpAlt) }`,
        `    }`,
        `    Write-Host "[MCP] Client Services URL candidates (auth=$authType): $($serviceUrls -join ' | ')"`,
        `    . $scripts.Ps -newtonSoftDllPath $newton -clientDllPath $clientDll -clientContextScriptPath $scripts.Cc`,
        `    # Always trust localhost / Cosmo self-signed certs for this process.`,
        `    # Disable-SslVerification may be missing when only vendored PsTest is present (no full BcContainerHelper module).`,
        `    # pwsh/.NET: never use Framework-only ICertificatePolicy (CS0246). Prefer vendored Disable-SslVerification`,
        `    # (ServicePointManager delegate) plus ClientContext HttpClient handler trust (see ClientContext.ps1).`,
        `    Write-Host '[MCP] Enabling process-level SSL trust-any (pwsh-safe; no ICertificatePolicy)'`,
        `    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
        `    if (Get-Command Disable-SslVerification -ErrorAction SilentlyContinue) {`,
        `      try { Disable-SslVerification; Write-Host '[MCP] Disable-SslVerification OK' } catch { Write-Host "[MCP] Disable-SslVerification failed: $($_.Exception.Message)" }`,
        `    } else {`,
        `      try {`,
        `        if (-not ([System.Management.Automation.PSTypeName]'McpSslVerification').Type) {`,
        `          Add-Type @'`,
        `using System.Net;`,
        `using System.Net.Security;`,
        `using System.Security.Cryptography.X509Certificates;`,
        `public static class McpSslVerification {`,
        `  public static bool Callback(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors sslPolicyErrors) { return true; }`,
        `  public static void Disable() { ServicePointManager.ServerCertificateValidationCallback = Callback; }`,
        `}`,
        `'@`,
        `        }`,
        `        [McpSslVerification]::Disable()`,
        `        Write-Host '[MCP] McpSslVerification ServicePointManager callback set'`,
        `      } catch {`,
        `        Write-Host "[MCP] McpSslVerification skipped: $($_.Exception.Message)"`,
        `        [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }`,
        `      }`,
        `    }`,
        `    $pagesToTry = @(130455, 130202, 130203, 130409)`,
        `    $interactionTimeout = [timespan]::FromMinutes(10)`,
        `    foreach ($serviceUrl in $serviceUrls) {`,
        `      if ($clientServicesOk) { break }`,
        `      Write-Host "[MCP] Trying Client Services URL: $serviceUrl"`,
        `      foreach ($testPage in $pagesToTry) {`,
        `        $clientContext = $null`,
        `        try {`,
        `          Write-Host "[MCP] New-ClientContext + Run-Tests testPage=$testPage"`,
        `          [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }`,
        `          if (Get-Command Disable-SslVerification -ErrorAction SilentlyContinue) { try { Disable-SslVerification } catch { } }`,
        `          $clientContext = New-ClientContext -serviceUrl $serviceUrl -auth $authType -credential $cred -interactionTimeout $interactionTimeout -culture 'en-US'`,
        `          $rtParams = @{`,
        `            clientContext = $clientContext`,
        `            TestSuite = $testSuite`,
        `            detailed = $true`,
        `            testPage = $testPage`,
        `            JUnitResultFileName = $junit`,
        `          }`,
        `          if ($extensionId) { $rtParams.ExtensionId = $extensionId }`,
        `          if ($testCodeunit) { $rtParams.TestCodeunit = $testCodeunit }`,
        `          if ($testFunction) { $rtParams.TestFunction = $testFunction }`,
        `          $allPassed = Run-Tests @rtParams`,
        `          $clientServicesOk = $true`,
        `          if (Test-Path $junit) { Write-Host "[MCP_JUNIT_BEGIN]"; Get-Content -Raw $junit; Write-Host "[MCP_JUNIT_END]" }`,
        `          if ($allPassed -eq $false) { Write-Host '[MCP] Some tests failed'; exit 2 }`,
        `          Write-Host '[MCP] Tests finished (Client Services / PsTestFunctions)'; exit 0`,
        `        } catch {`,
        `          $lastCsError = $_.Exception.Message`,
        `          Write-Host "[MCP] testPage $testPage failed: $lastCsError"`,
        `          if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }`,
        `        } finally {`,
        `          if ($clientContext -and (Get-Command Remove-ClientContext -ErrorAction SilentlyContinue)) {`,
        `            try { Remove-ClientContext -clientContext $clientContext } catch { }`,
        `          }`,
        `        }`,
        `        if ($clientServicesOk) { break }`,
        `      }`,
        `    }`,
        `  } catch {`,
        `    $lastCsError = $_.Exception.Message`,
        `    Write-Host "[MCP] Client Services path setup failed: $lastCsError"`,
        `  }`,
        `} else {`,
        `  Write-Host '[MCP] Could not obtain PsTestFunctions.ps1 / ClientContext.ps1 (scp upload missing and Install-Module failed).'`,
        `}`,
        `# --- Path 3 (Option B): BC 27.5+/28 CLI Test Runner codeunit 130201 ---`,
        `Write-Host '[MCP] Option B: Invoke-NAVCodeunit CLI Test Runner (codeunit 130201 / TestRunner-Internal)'`,
        `Write-Host '[MCP] Note: page 130455 was removed in BC 27.5+; codeunit 130201 is the documented replacement. This path is best-effort via Invoke-NAVCodeunit (no rich JUnit from Snap unless the codeunit writes results).'`,
        `if (Get-Command Invoke-NAVCodeunit -ErrorAction SilentlyContinue) {`,
        `  try {`,
        `    $si = $null`,
        `    if (Get-Command Get-NAVServerInstance -ErrorAction SilentlyContinue) {`,
        `      $inst = Get-NAVServerInstance | Select-Object -First 1`,
        `      if ($inst) { $si = $inst.ServerInstance }`,
        `    }`,
        `    if (-not $si -and $env:ServerInstance) { $si = $env:ServerInstance }`,
        `    if (-not $si -and $env:webserverinstance) { $si = $env:webserverinstance }`,
        `    if (-not $si) { $si = 'BC' }`,
        `    Write-Host "[MCP] Invoke-NAVCodeunit -ServerInstance $si -CodeunitId 130201 -CompanyName $companyName -Tenant $tenant"`,
        `    Invoke-NAVCodeunit -ServerInstance $si -Tenant $tenant -CompanyName $companyName -CodeunitId 130201 -ErrorAction Stop`,
        `    Write-Host '[MCP] Invoke-NAVCodeunit 130201 completed (check NST/event log for Snap / CLI Test Runner detail)'`,
        `    Write-Host 'Passed: 0'`,
        `    Write-Host '[MCP] Option B finished without JUnit — treat as inconclusive unless logs show results'; exit 5`,
        `  } catch {`,
        `    Write-Host "[MCP] Option B Invoke-NAVCodeunit 130201 failed: $($_.Exception.Message)"`,
        `  }`,
        `} else {`,
        `  Write-Host '[MCP] Invoke-NAVCodeunit not available (Prompt.ps1 / NAV Management module missing?).'`,
        `}`,
        `# Diagnostics — soft guidance (toolkit often already present on Cosmo)`,
        `Write-Host '[MCP] All in-container runners failed.'`,
        `if ($lastCsError) { Write-Host "[MCP] Last Client Services error: $lastCsError" }`,
        `Write-Host '[MCP] If Test Toolkit apps are missing, publish Test Runner + libraries first (bc_dev_publish_* / cosmo_deploy), then verify:'`,
        `Write-Host '  Get-NAVAppInfo -ServerInstance <si> -TenantDefaultCompany | Where-Object { $_.Name -match ''Test'' }'`,
        `Write-Host '  (Expect Test Runner, Tests-TestLibraries, Library Assert, etc.)'`,
        `if (Get-Command Get-NAVAppInfo -ErrorAction SilentlyContinue) {`,
        `  try {`,
        `    $si2 = $si; if (-not $si2) { $si2 = 'BC' }`,
        `    Get-NAVAppInfo -ServerInstance $si2 -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Test' } | Select-Object -First 20 Name, Version | Format-Table -AutoSize | Out-String | Write-Host`,
        `  } catch { }`,
        `}`,
        `exit 3`,
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
    const remoteId = randomBytes(8).toString("hex");
    const { winPath: remoteWinPath, scpPath: remoteScpPath } = remoteRunTestsPath(remoteId);
    // Windows paths embedded into the remote PS1 (single backslash for PowerShell)
    const remotePsWin = "C:\\Windows\\Temp\\origo-bc-pstest-" + remoteId + "-PsTestFunctions.ps1";
    const remoteCcWin = "C:\\Windows\\Temp\\origo-bc-pstest-" + remoteId + "-ClientContext.ps1";
    const remotePsScp = `C:/Windows/Temp/origo-bc-pstest-${remoteId}-PsTestFunctions.ps1`;
    const remoteCcScp = `C:/Windows/Temp/origo-bc-pstest-${remoteId}-ClientContext.ps1`;
    const helpers = resolvePsTestHelperPaths();
    const remoteScript = buildRemoteTestScript(input, conn, {
        remotePsTestFunctions: helpers.psTestFunctions ? remotePsWin : "",
        remoteClientContext: helpers.clientContext ? remoteCcWin : "",
    });
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
    const commandPreview = `scp -i <key> -P ${port} run-tests.ps1[+pstest] ${target}:${remoteScpPath} && ` +
        `ssh -i <key> -p ${port} ${target} pwsh|powershell -NoProfile -File ${remoteWinPath}` +
        `  # extensionId=${input.extensionId ?? ""} in-container Client Services`;
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
    if (scpProc.exitCode === 0 && helpers.psTestFunctions && helpers.clientContext) {
        const scpPs = await runProcess("scp", [...scpOpts, helpers.psTestFunctions, `${target}:${remotePsScp}`], { timeoutMs: scpTimeout });
        const scpCc = await runProcess("scp", [...scpOpts, helpers.clientContext, `${target}:${remoteCcScp}`], { timeoutMs: scpTimeout });
        if (scpPs.exitCode !== 0 || scpCc.exitCode !== 0) {
            // Non-fatal: remote script can Install-Module BcContainerHelper as Option A fallback
            scpProc.stderr +=
                `\n[MCP] pstest helper scp failed (ps=${scpPs.exitCode}, cc=${scpCc.exitCode}); remote will try Install-Module\n` +
                    truncate(scpPs.stderr + "\n" + scpCc.stderr, 2000);
        }
    }
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
    const delPs = `Remove-Item -LiteralPath '${remoteWinPath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue; ` +
        `Remove-Item -LiteralPath '${remotePsWin.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue; ` +
        `Remove-Item -LiteralPath '${remoteCcWin.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`;
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
            : "SSH ran in-container Client Services / PsTestFunctions (or Option B codeunit 130201) but tests did not all pass. " +
                "Cosmo SSH is inside the BC container — not host BcContainerHelper. " +
                "If pages 130455/130202 fail, check Test Toolkit via Get-NAVAppInfo; verify extensionId/companyName.",
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