/**
 * bc_dev_build_runtime_package — release build of an AL app plus its runtime package.
 *
 * One call does what the AL-Go "Default" build mode does to the manifest and then what
 * AL-Go cannot do on Cosmo Alpaca (Run-AlPipeline -CreateRuntimePackages is hard-coded
 * off, and Alpaca containers are remote):
 *
 *   1. copy the AL project to a temp folder (the working tree is never modified),
 *   2. strip `internalsVisibleTo` and the matching suppressions (AS0081) from the copy,
 *   3. compile with the local alc.exe (VS Code AL extension) + analyzers,
 *   4. publish the .app through the Developer Services endpoint (caller supplies publish),
 *   5. SSH into the Cosmo container (lands inside it as sshuser), dot-source
 *      C:\Run\Prompt.ps1 and run Get-NAVAppRuntimePackage,
 *   6. scp the runtime package back next to the compiled .app.
 *
 * Never logs or echoes the SSH private key.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fetchCosmoSshInfo, runProcess, scpClientOpts, sshClientOpts, sshUsable, wait, } from "./runTests.js";
const ALL_ANALYZERS = {
    CodeCop: "Microsoft.Dynamics.Nav.CodeCop.dll",
    UICop: "Microsoft.Dynamics.Nav.UICop.dll",
    AppSourceCop: "Microsoft.Dynamics.Nav.AppSourceCop.dll",
    PerTenantExtensionCop: "Microsoft.Dynamics.Nav.PerTenantExtensionCop.dll",
};
/** Folders/files at the project root that the compile copy does not need. */
const COPY_EXCLUDES = new Set([".alpackages", "output", ".snapshots", ".vscode", ".git", "node_modules"]);
function truncate(s, max = 8000) {
    return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}
function escPs(s) {
    return s.replace(/'/g, "''");
}
function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}
/** Characters Windows rejects in file names. */
function safeFilePart(s) {
    return s.replace(/[<>:"/\\|?*]/g, "_");
}
/** AL convention: <Publisher>_<Name>_<Version>.app (and .runtime.app for the runtime package). */
export function appFileNames(manifest) {
    const stem = `${safeFilePart(manifest.publisher)}_${safeFilePart(manifest.name)}_${safeFilePart(manifest.version)}`;
    return { app: `${stem}.app`, runtime: `${stem}.runtime.app` };
}
export function parseManifest(text) {
    const obj = JSON.parse(text.replace(/^\uFEFF/, ""));
    for (const key of ["id", "name", "publisher", "version"]) {
        if (typeof obj[key] !== "string" || !obj[key].trim()) {
            throw new Error(`app.json is missing "${key}".`);
        }
    }
    return obj;
}
/**
 * Release manifest: removes internalsVisibleTo and the listed suppressions (AS0081 by
 * default, which only exists to silence the internalsVisibleTo warning). Mirrors
 * .AL-Go/PreCompileApp.ps1 in the Bifrost repos.
 */
export function toReleaseManifest(manifest, dropSuppressWarnings = ["AS0081"]) {
    const copy = JSON.parse(JSON.stringify(manifest));
    let removedInternalsVisibleTo = 0;
    if (Object.prototype.hasOwnProperty.call(copy, "internalsVisibleTo")) {
        const ivt = copy.internalsVisibleTo;
        removedInternalsVisibleTo = Array.isArray(ivt) ? ivt.length : 1;
        delete copy.internalsVisibleTo;
    }
    const removedSuppressions = [];
    if (Array.isArray(copy.suppressWarnings)) {
        const drop = new Set(dropSuppressWarnings.map((w) => w.toUpperCase()));
        copy.suppressWarnings = copy.suppressWarnings.filter((w) => {
            if (typeof w === "string" && drop.has(w.toUpperCase())) {
                removedSuppressions.push(w);
                return false;
            }
            return true;
        });
    }
    return { manifest: copy, removedInternalsVisibleTo, removedSuppressions };
}
function compareVersionDirs(a, b) {
    const va = (a.match(/(\d+(?:\.\d+)*)$/)?.[1] ?? "0").split(".").map(Number);
    const vb = (b.match(/(\d+(?:\.\d+)*)$/)?.[1] ?? "0").split(".").map(Number);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (va[i] ?? 0) - (vb[i] ?? 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
/**
 * alc.exe: explicit path, AL_COMPILER_PATH, or the newest ms-dynamics-smb.al-* VS Code
 * extension (bin\win32\alc.exe on AL 17, bin\alc.exe on AL 18).
 */
export function resolveAlcPath(explicit, extensionsRoot) {
    for (const candidate of [explicit, process.env.AL_COMPILER_PATH]) {
        if (candidate?.trim() && existsSync(candidate.trim()))
            return candidate.trim();
    }
    const root = extensionsRoot ?? join(homedir(), ".vscode", "extensions");
    if (!existsSync(root))
        return undefined;
    const dirs = readdirSync(root)
        .filter((d) => d.toLowerCase().startsWith("ms-dynamics-smb.al-"))
        .sort(compareVersionDirs)
        .reverse();
    const exe = process.platform === "win32" ? "alc.exe" : "alc";
    const sub = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    for (const d of dirs) {
        for (const p of [join(root, d, "bin", exe), join(root, d, "bin", sub, exe)]) {
            if (existsSync(p))
                return p;
        }
    }
    return undefined;
}
/** Analyzer dlls sit next to alc.exe, in bin\Analyzers, or one level up (AL 17 win32 layout). */
export function resolveAnalyzerPaths(alcPath, analyzers) {
    const binDir = dirname(alcPath);
    const searchDirs = [binDir, join(binDir, "Analyzers"), join(binDir, ".."), join(binDir, "..", "Analyzers")];
    const found = [];
    const missing = [];
    for (const name of analyzers) {
        const file = ALL_ANALYZERS[name];
        const hit = searchDirs.map((d) => join(d, file)).find((p) => existsSync(p));
        if (hit)
            found.push(resolve(hit));
        else
            missing.push(name);
    }
    return { found, missing };
}
export function parseCompilerOutput(text) {
    const errors = [];
    const warnings = [];
    for (const line of text.split(/\r?\n/)) {
        if (/:\s*error\s+[A-Z]{2}\d{4}/i.test(line))
            errors.push(line.trim());
        else if (/:\s*warning\s+[A-Z]{2}\d{4}/i.test(line))
            warnings.push(line.trim());
    }
    return { errors, warnings };
}
export function buildAlcArgs(opts) {
    return [
        `/project:${opts.projectDir}`,
        `/packagecachepath:${opts.packageCachePath}`,
        `/out:${opts.outFile}`,
        ...opts.analyzerPaths.map((p) => `/analyzer:${p}`),
    ];
}
/**
 * Remote PowerShell (inside the BC container): load the NAV management cmdlets via
 * Prompt.ps1 and write the runtime package. -Tenant is only passed when the cmdlet has it
 * (dev-endpoint publishes are tenant scoped).
 */
export function buildRuntimePackageScript(opts) {
    return [
        "$ErrorActionPreference = 'Stop'",
        "if (Test-Path 'C:\\Run\\Prompt.ps1') { . 'C:\\Run\\Prompt.ps1' | Out-Null }",
        "if (-not (Get-Command Get-NAVAppRuntimePackage -ErrorAction SilentlyContinue)) {",
        "  Write-Host '[MCP_RUNTIME_ERROR] Get-NAVAppRuntimePackage not available (NAV management module missing).'; exit 3",
        "}",
        "$si = $null",
        "if (Get-Command Get-NAVServerInstance -ErrorAction SilentlyContinue) {",
        "  $inst = Get-NAVServerInstance | Select-Object -First 1",
        "  if ($inst) { $si = ($inst.ServerInstance -replace '^.*\\$', '') }",
        "}",
        "if (-not $si) { $si = 'BC' }",
        `$params = @{ ServerInstance = $si; AppName = '${escPs(opts.appName)}'; Publisher = '${escPs(opts.publisher)}'; Version = '${escPs(opts.version)}'; Path = '${escPs(opts.remotePath)}' }`,
        `if ((Get-Command Get-NAVAppRuntimePackage).Parameters.ContainsKey('Tenant')) { $params.Tenant = '${escPs(opts.tenant)}' }`,
        "try {",
        "  Get-NAVAppRuntimePackage @params",
        "} catch {",
        "  Write-Host \"[MCP_RUNTIME_ERROR] $($_.Exception.Message)\"",
        `  Get-NAVAppInfo -ServerInstance $si -Name '${escPs(opts.appName)}' -ErrorAction SilentlyContinue | Format-Table Name, Publisher, Version, Scope -AutoSize | Out-String | Write-Host`,
        "  exit 4",
        "}",
        `if (-not (Test-Path '${escPs(opts.remotePath)}')) { Write-Host '[MCP_RUNTIME_ERROR] Runtime package was not written.'; exit 5 }`,
        `Write-Host "[MCP_RUNTIME_OK] $((Get-Item '${escPs(opts.remotePath)}').Length)"`,
    ].join("\r\n");
}
function copyProject(projectPath, dest) {
    cpSync(projectPath, dest, {
        recursive: true,
        filter: (src) => {
            if (src === projectPath)
                return true;
            const rel = src.slice(projectPath.length).replace(/^[\\/]+/, "");
            const top = rel.split(/[\\/]/)[0] ?? "";
            if (COPY_EXCLUDES.has(top))
                return false;
            // stray build outputs at the project root
            if (!rel.includes("\\") && !rel.includes("/") && rel.toLowerCase().endsWith(".app"))
                return false;
            return true;
        },
    });
}
async function compile(alcPath, args, appFile, timeoutMs) {
    const proc = await runProcess(alcPath, args, { timeoutMs });
    const { errors, warnings } = parseCompilerOutput(proc.stdout + "\n" + proc.stderr);
    const ok = proc.exitCode === 0 && errors.length === 0 && existsSync(appFile);
    return {
        ok,
        exitCode: proc.exitCode,
        appFile,
        errors: errors.slice(0, 50),
        warnings: warnings.slice(0, 50),
        durationMs: proc.durationMs,
        commandPreview: `${basename(alcPath)} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
    };
}
async function sshInfoWithRetry(containerId) {
    const attempts = Math.max(1, Number(process.env.BC_DEV_SSH_RETRIES || 4));
    const delayMs = Math.max(0, Number(process.env.BC_DEV_SSH_RETRY_MS || 8000));
    let lastError = "";
    for (let i = 0; i < attempts; i++) {
        try {
            const info = await fetchCosmoSshInfo(containerId);
            if (sshUsable(info))
                return info;
            lastError = `cosmo_ssh_info has no ipAddress/privateKey (keys: ${info.rawKeys.join(", ")})`;
        }
        catch (err) {
            lastError = `cosmo_ssh_info failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (i < attempts - 1)
            await wait(delayMs);
    }
    return lastError;
}
/** Runs the whole release build. `publish` posts the .app to the session's dev endpoint. */
export async function buildRuntimePackage(input, publish) {
    const steps = [];
    const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
    const projectPath = resolve(input.projectPath);
    const manifestPath = join(projectPath, "app.json");
    // 1-2. release manifest in a temp copy
    let release;
    try {
        if (!existsSync(manifestPath))
            throw new Error(`No app.json in ${projectPath}.`);
        release = toReleaseManifest(parseManifest(readFileSync(manifestPath, "utf8")), input.dropSuppressWarnings);
    }
    catch (err) {
        return { ok: false, failedStep: "manifest", error: err instanceof Error ? err.message : String(err), steps };
    }
    const m = release.manifest;
    const app = { id: m.id, name: m.name, publisher: m.publisher, version: m.version };
    const names = appFileNames(m);
    const outputDir = resolve(input.outputDir ?? join(projectPath, "output", "release"));
    mkdirSync(outputDir, { recursive: true });
    const appFile = join(outputDir, names.app);
    const runtimeFile = join(outputDir, names.runtime);
    for (const f of [appFile, runtimeFile])
        rmSync(f, { force: true });
    const alcPath = resolveAlcPath(input.alcPath);
    if (!alcPath) {
        return {
            ok: false,
            failedStep: "compile",
            app,
            error: "alc.exe not found.",
            hint: "Pass alcPath, set AL_COMPILER_PATH, or install the AL Language extension in VS Code.",
            steps,
        };
    }
    const analyzers = input.analyzers ?? ["CodeCop", "UICop", "AppSourceCop"];
    const { found: analyzerPaths, missing } = resolveAnalyzerPaths(alcPath, analyzers);
    if (missing.length) {
        return {
            ok: false,
            failedStep: "compile",
            app,
            error: `Analyzer(s) not found next to ${alcPath}: ${missing.join(", ")}`,
            steps,
        };
    }
    const workDir = mkdtempSync(join(tmpdir(), "origo-bc-release-"));
    const buildDir = join(workDir, basename(projectPath));
    try {
        copyProject(projectPath, buildDir);
        writeFileSync(join(buildDir, "app.json"), JSON.stringify(m, null, 2) + "\n", "utf8");
        steps.push(`manifest: removed internalsVisibleTo (${release.removedInternalsVisibleTo})` +
            (release.removedSuppressions.length ? ` and ${release.removedSuppressions.join(", ")}` : ""));
        // 3. compile
        const args = buildAlcArgs({
            projectDir: buildDir,
            packageCachePath: resolve(input.packageCachePath ?? join(projectPath, ".alpackages")),
            outFile: appFile,
            analyzerPaths,
        });
        const compiled = await compile(alcPath, args, appFile, timeoutMs);
        const { ok: compileOk, ...compileInfo } = compiled;
        if (!compileOk) {
            return {
                ok: false,
                failedStep: "compile",
                app,
                compile: compileInfo,
                removedInternalsVisibleTo: release.removedInternalsVisibleTo,
                removedSuppressions: release.removedSuppressions,
                error: `Compilation failed (${compiled.errors.length} error(s)).`,
                steps,
            };
        }
        steps.push(`compile: ${basename(appFile)} (${compiled.warnings.length} warning(s))`);
        const base = {
            ok: false,
            app,
            appFile,
            appSha256: sha256File(appFile),
            compile: compileInfo,
            removedInternalsVisibleTo: release.removedInternalsVisibleTo,
            removedSuppressions: release.removedSuppressions,
            steps,
        };
        // 4. publish
        const published = await publish(appFile);
        base.publish = published;
        if (!published.ok) {
            return { ...base, failedStep: "publish", error: published.error ?? `Publish returned HTTP ${published.statusCode}.` };
        }
        steps.push(`publish: HTTP ${published.statusCode ?? "?"}`);
        // 5. runtime package over Cosmo SSH
        const ssh = await sshInfoWithRetry(input.containerId);
        if (typeof ssh === "string") {
            return {
                ...base,
                failedStep: "ssh",
                error: ssh,
                hint: "The container needs SSH (create with sshEnabled=true, or Stop→Start and re-check cosmo_ssh_info). " +
                    "The .app above is built and published; only the runtime package is missing.",
            };
        }
        const keyPath = join(workDir, "cosmo_ssh_key");
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
        const port = ssh.port || "22";
        const user = input.sshUser?.trim() || process.env.COSMO_SSH_USER?.trim() || "sshuser";
        const target = `${user}@${ssh.ipAddress}`;
        const remoteId = randomBytes(8).toString("hex");
        const remoteScriptWin = `C:\\Windows\\Temp\\origo-bc-runtime-${remoteId}.ps1`;
        const remoteScriptScp = `C:/Windows/Temp/origo-bc-runtime-${remoteId}.ps1`;
        const remotePkgWin = `C:\\Windows\\Temp\\origo-bc-runtime-${remoteId}.app`;
        const remotePkgScp = `C:/Windows/Temp/origo-bc-runtime-${remoteId}.app`;
        const localScript = join(workDir, "runtime-package.ps1");
        writeFileSync(localScript, buildRuntimePackageScript({
            appName: m.name,
            publisher: m.publisher,
            version: m.version,
            tenant: input.tenant?.trim() || "default",
            remotePath: remotePkgWin,
        }), "utf8");
        const sshOpts = sshClientOpts(keyPath, port);
        const scpOpts = scpClientOpts(keyPath, port);
        const up = await runProcess("scp", [...scpOpts, localScript, `${target}:${remoteScriptScp}`], {
            timeoutMs: 60_000,
        });
        if (up.exitCode !== 0) {
            return { ...base, failedStep: "ssh", error: "scp of the runtime-package script failed.", remoteOutputPreview: truncate(up.stderr, 2000) };
        }
        let proc = await runProcess("ssh", [...sshOpts, target, "powershell.exe", "-NoProfile", "-File", remoteScriptWin], {
            timeoutMs,
        });
        const output = `${proc.stdout}\n${proc.stderr}`;
        let result;
        if (proc.exitCode !== 0 || !output.includes("[MCP_RUNTIME_OK]")) {
            const reason = output.match(/\[MCP_RUNTIME_ERROR\]\s*(.*)/)?.[1]?.trim();
            result = {
                ...base,
                failedStep: "runtimePackage",
                error: reason || `Remote script exited with ${proc.exitCode}.`,
                remoteOutputPreview: truncate(output, 4000),
                hint: "Check that projectPath's app was published to the same container as containerId.",
            };
        }
        else {
            // 6. download
            proc = await runProcess("scp", [...scpOpts, `${target}:${remotePkgScp}`, runtimeFile], { timeoutMs: 5 * 60_000 });
            if (proc.exitCode !== 0 || !existsSync(runtimeFile)) {
                result = { ...base, failedStep: "download", error: "scp download of the runtime package failed.", remoteOutputPreview: truncate(proc.stderr, 2000) };
            }
        }
        try {
            await runProcess("ssh", [
                ...sshOpts,
                target,
                "powershell.exe",
                "-NoProfile",
                "-Command",
                `Remove-Item -LiteralPath '${escPs(remoteScriptWin)}','${escPs(remotePkgWin)}' -Force -ErrorAction SilentlyContinue`,
            ], { timeoutMs: 15_000 });
        }
        catch {
            /* best effort */
        }
        if (result)
            return result;
        steps.push(`runtimePackage: ${basename(runtimeFile)}`);
        return {
            ...base,
            ok: true,
            runtimePackageFile: runtimeFile,
            runtimePackageSha256: sha256File(runtimeFile),
            runtimePackageBytes: statSync(runtimeFile).size,
        };
    }
    finally {
        try {
            rmSync(workDir, { recursive: true, force: true });
        }
        catch {
            /* best effort: key material + build copy */
        }
    }
}
//# sourceMappingURL=runtimePackage.js.map