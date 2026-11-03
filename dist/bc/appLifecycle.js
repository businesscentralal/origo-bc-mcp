/**
 * App lifecycle inside a Cosmo BC container: sync, install, uninstall and data clean-up over
 * SSH (NAV management cmdlets), plus the "reinstall what the publish uninstalled" loop used by
 * bc_dev_publish_* (reinstallDependents).
 *
 * Why SSH: a dev-endpoint publish of a base app (e.g. Bifröst Foundation) uninstalls every app
 * that depends on it, and the Automation API cannot always reinstall them (data upgrade needed,
 * leftover data from a newer unpublished version). Sync-NAVApp / Install-NAVApp /
 * Start-NAVAppDataUpgrade / Uninstall-NAVApp -DoNotSaveData / Sync-NAVApp -Mode Clean cover those.
 *
 * Leftover data clean-up (bc_dev_clean_app_data):
 *   BC remembers the data version of an app id per tenant even after that version is unpublished,
 *   and refuses to install an older version ("a newer version … was already installed").
 *   The supported way to drop it is Sync-NAVApp -Mode Clean, which removes the app's tables and
 *   the tenant's schema/data record for that app id; it needs *some* version of the app id
 *   published, so: publish the version you want (dev publish fails to install it — fine), run
 *   clean, then install. Installed versions are first uninstalled with -DoNotSaveData (and
 *   -ClearSchema where the cmdlet has it). Remove-NAVAppsForTenant is not used: it removes every
 *   app of the tenant, far more than one app's data.
 */
import { escPs, PS_PREAMBLE, runContainerScript } from "./containerScript.js";
import { automationAuthError, automationBoundAction, findExtensions, } from "./developer.js";
const GUID_RE = /^[{(]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[)}]?$/i;
export function isGuid(value) {
    return Boolean(value && GUID_RE.test(value.trim()));
}
export function normalizeGuid(value) {
    return value.trim().replace(/^[{(]|[)}]$/g, "").toLowerCase();
}
function selectorLines(sel) {
    if (!sel.appId && !sel.name)
        throw new Error("Provide appId or name.");
    if (sel.appId && !isGuid(sel.appId))
        throw new Error(`appId must be a GUID, got '${sel.appId}'.`);
    if (sel.version && !/^\d+(\.\d+){1,3}$/.test(sel.version.trim())) {
        throw new Error(`version must look like 28.0.11.659, got '${sel.version}'.`);
    }
    return [
        `$tenant = '${escPs(sel.tenant?.trim() || "default")}'`,
        `$appId = '${escPs(sel.appId ? normalizeGuid(sel.appId) : "")}'`,
        `$appName = '${escPs(sel.name?.trim() ?? "")}'`,
        `$appPublisher = '${escPs(sel.publisher?.trim() ?? "")}'`,
        `$appVersion = '${escPs(sel.version?.trim() ?? "")}'`,
        "function IdOf($r) { if ($r.AppId) { \"$($r.AppId)\".Trim('{}').ToLower() } else { \"$($r.Id)\".Trim('{}').ToLower() } }",
        "function Get-McpRows {",
        "  @(Get-NAVAppInfo -ServerInstance $si -Tenant $tenant -TenantSpecificProperties -ErrorAction Stop) | Where-Object {",
        "    (-not $appId -or (IdOf $_) -eq $appId) -and (-not $appName -or $_.Name -eq $appName) -and (-not $appPublisher -or $_.Publisher -eq $appPublisher)",
        "  }",
        "}",
        "function Snap($rows) { @($rows | ForEach-Object { [ordered]@{ appId = (IdOf $_); name = $_.Name; publisher = $_.Publisher; version = \"$($_.Version)\"; isInstalled = [bool]$_.IsInstalled; syncState = \"$($_.SyncState)\"; needsUpgrade = [bool]$_.NeedsUpgrade; extensionDataVersion = \"$($_.ExtensionDataVersion)\"; scope = \"$($_.Scope)\" } }) }",
        "function Has($cmd, $param) { (Get-Command $cmd).Parameters.ContainsKey($param) }",
        "function Target($rows) {",
        "  if ($appVersion) { return @($rows | Where-Object { \"$($_.Version)\" -eq $appVersion }) | Select-Object -First 1 }",
        "  return @($rows | Sort-Object { [version]\"$($_.Version)\" } -Descending) | Select-Object -First 1",
        "}",
        "function AppParams($r) { @{ ServerInstance = $si; Tenant = $tenant; Name = $r.Name; Publisher = $r.Publisher; Version = $r.Version } }",
        "$steps = New-Object System.Collections.Generic.List[string]",
        "$rows = @(Get-McpRows)",
        "if (-not $rows.Count) { Emit @{ ok = $false; error = 'No published app matches the selector on this tenant.'; selector = @{ appId = $appId; name = $appName; publisher = $appPublisher; version = $appVersion } }; exit 4 }",
        "$ids = @($rows | ForEach-Object { IdOf $_ } | Select-Object -Unique)",
        "if ($ids.Count -gt 1) { Emit @{ ok = $false; error = 'More than one app id matches; pass appId.'; matches = (Snap $rows) }; exit 4 }",
        "$before = Snap $rows",
    ];
}
/**
 * Sync (and optionally install) one app version. When another version of the same app is
 * installed, or the tenant holds data from an older version, the install becomes
 * Start-NAVAppDataUpgrade.
 */
export function buildInstallScript(sel, opts) {
    const mode = opts.syncMode ?? "Add";
    return [
        ...PS_PREAMBLE,
        ...selectorLines(sel),
        "$target = Target $rows",
        "if (-not $target) { Emit @{ ok = $false; error = \"Version $appVersion of this app is not published.\"; before = $before }; exit 4 }",
        "$p = AppParams $target",
        `$syncMode = '${mode}'`,
        "try {",
        "  $sp = $p.Clone(); $sp.Mode = $syncMode",
        "  if ($syncMode -eq 'Clean' -or $syncMode -eq 'ForceSync') { $sp.Force = $true }",
        "  Sync-NAVApp @sp",
        "  $steps.Add(\"Sync-NAVApp -Mode $syncMode $($target.Version)\")",
        "} catch {",
        "  Emit @{ ok = $false; failedStep = 'sync'; error = $_.Exception.Message; steps = $steps; before = $before }; exit 5",
        "}",
        opts.install
            ? [
                "$installedOther = @($rows | Where-Object { $_.IsInstalled -and \"$($_.Version)\" -ne \"$($target.Version)\" })",
                "$fresh = @(Get-McpRows) | Where-Object { \"$($_.Version)\" -eq \"$($target.Version)\" } | Select-Object -First 1",
                "if ($fresh -and $fresh.IsInstalled) {",
                "  $steps.Add('already installed')",
                "} else {",
                "  try {",
                "    if ($installedOther.Count -or ($fresh -and $fresh.NeedsUpgrade)) {",
                "      Start-NAVAppDataUpgrade @p; $steps.Add(\"Start-NAVAppDataUpgrade $($target.Version)\")",
                "    } else {",
                "      try { Install-NAVApp @p; $steps.Add(\"Install-NAVApp $($target.Version)\") }",
                "      catch {",
                "        if ($_.Exception.Message -match 'upgrade') { Start-NAVAppDataUpgrade @p; $steps.Add(\"Start-NAVAppDataUpgrade $($target.Version) (after: $($_.Exception.Message))\") }",
                "        else { throw }",
                "      }",
                "    }",
                "  } catch {",
                "    Emit @{ ok = $false; failedStep = 'install'; error = $_.Exception.Message; steps = $steps; before = $before; after = (Snap (Get-McpRows)) }; exit 6",
                "  }",
                "}",
            ].join("\n")
            : "",
        "Emit @{ ok = $true; serverInstance = $si; tenant = $tenant; target = \"$($target.Version)\"; steps = $steps; before = $before; after = (Snap (Get-McpRows)) }",
        "exit 0",
    ]
        .filter(Boolean)
        .join("\n");
}
/** Uninstall the installed version(s) of an app, optionally without keeping its data. */
export function buildUninstallScript(sel, opts) {
    return [
        ...PS_PREAMBLE,
        ...selectorLines(sel),
        "$installed = @($rows | Where-Object { $_.IsInstalled -and (-not $appVersion -or \"$($_.Version)\" -eq $appVersion) })",
        "if (-not $installed.Count) { Emit @{ ok = $true; steps = @('nothing installed'); before = $before; after = $before }; exit 0 }",
        "try {",
        "  foreach ($r in $installed) {",
        "    $up = AppParams $r; $up.Force = $true",
        opts.doNotSaveData ? "    $up.DoNotSaveData = $true" : "",
        opts.clearSchema
            ? "    if (Has 'Uninstall-NAVApp' 'ClearSchema') { $up.ClearSchema = $true } else { $steps.Add('Uninstall-NAVApp has no -ClearSchema on this version') }"
            : "",
        "    Uninstall-NAVApp @up",
        "    $steps.Add(\"Uninstall-NAVApp $($r.Version)$(if ($up.DoNotSaveData) { ' -DoNotSaveData' })$(if ($up.ClearSchema) { ' -ClearSchema' })\")",
        "  }",
        "} catch {",
        "  Emit @{ ok = $false; failedStep = 'uninstall'; error = $_.Exception.Message; steps = $steps; before = $before; after = (Snap (Get-McpRows)) }; exit 5",
        "}",
        "Emit @{ ok = $true; serverInstance = $si; tenant = $tenant; steps = $steps; before = $before; after = (Snap (Get-McpRows)) }",
        "exit 0",
    ]
        .filter(Boolean)
        .join("\n");
}
/**
 * Remove every trace of one app id's data on the tenant: uninstall installed versions with
 * -DoNotSaveData (+ -ClearSchema when available), then Sync-NAVApp -Mode Clean against a
 * published version (the requested one, else the highest). Needs one published version.
 */
export function buildCleanAppDataScript(sel) {
    if (!isGuid(sel.appId))
        throw new Error("appId (GUID) is required for clean-up.");
    return [
        ...PS_PREAMBLE,
        // A missing published version is the one case with no in-container fix, so say what to do.
        ...selectorLines(sel).map((l) => l.startsWith("if (-not $rows.Count)")
            ? "if (-not $rows.Count) { Emit @{ ok = $false; error = 'No version of this app id is published on the tenant. Sync-NAVApp -Mode Clean needs one: publish any version (e.g. the one you want to install) with bc_dev_publish_app, then run bc_dev_clean_app_data again.' }; exit 4 }"
            : l),
        "try {",
        "  foreach ($r in @($rows | Where-Object { $_.IsInstalled })) {",
        "    $up = AppParams $r; $up.Force = $true; $up.DoNotSaveData = $true",
        "    if (Has 'Uninstall-NAVApp' 'ClearSchema') { $up.ClearSchema = $true }",
        "    Uninstall-NAVApp @up",
        "    $steps.Add(\"Uninstall-NAVApp $($r.Version) -DoNotSaveData$(if ($up.ClearSchema) { ' -ClearSchema' })\")",
        "  }",
        "} catch {",
        "  Emit @{ ok = $false; failedStep = 'uninstall'; error = $_.Exception.Message; steps = $steps; before = $before }; exit 5",
        "}",
        "$target = Target $rows",
        "if (-not $target) { Emit @{ ok = $false; error = \"Version $appVersion is not published; omit version to use the highest published one.\"; before = $before }; exit 4 }",
        "try {",
        "  $sp = AppParams $target; $sp.Mode = 'Clean'; $sp.Force = $true",
        "  Sync-NAVApp @sp",
        "  $steps.Add(\"Sync-NAVApp -Mode Clean $($target.Version)\")",
        "} catch {",
        "  Emit @{ ok = $false; failedStep = 'syncClean'; error = $_.Exception.Message; steps = $steps; before = $before; after = (Snap (Get-McpRows)) }; exit 6",
        "}",
        "Emit @{ ok = $true; serverInstance = $si; tenant = $tenant; cleanedWith = \"$($target.Version)\"; steps = $steps; before = $before; after = (Snap (Get-McpRows)) }",
        "exit 0",
    ].join("\n");
}
function versionOf(e) {
    return [e.versionMajor ?? 0, e.versionMinor ?? 0, e.versionBuild ?? 0, e.versionRevision ?? 0];
}
function compareVersions(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
function appIdOf(e) {
    return (e.id ?? e.packageId).toLowerCase();
}
function ref(e) {
    return {
        appId: appIdOf(e),
        name: e.displayName,
        publisher: e.publisher,
        version: versionOf(e).join("."),
        packageId: e.packageId,
    };
}
/**
 * Reinstalls every app that was installed before a publish and has no installed version after
 * it. Dependency order comes from retrying: each pass installs what it can, a failed install is
 * retried once the apps it depends on are back, and the loop stops when a pass makes no progress.
 * Prefers the version that was installed before; else the highest published version.
 */
export async function reinstallDependents(before, listAfter, install, opts = {}) {
    const installedBefore = before.filter((e) => e.isInstalled);
    let after = await listAfter();
    const isInstalledNow = (id) => after.some((e) => e.isInstalled && appIdOf(e) === id);
    const pending = new Map();
    for (const e of installedBefore) {
        if (!isInstalledNow(appIdOf(e)))
            pending.set(appIdOf(e), e);
    }
    const uninstalledByPublish = [...pending.values()].map(ref);
    const reinstalled = [];
    const lastError = new Map();
    const failed = [];
    const maxPasses = Math.max(1, Math.min(opts.maxPasses ?? pending.size + 1, 20));
    let passes = 0;
    while (pending.size && passes < maxPasses) {
        passes++;
        for (const [id, prev] of pending) {
            const candidates = after.filter((e) => appIdOf(e) === id);
            const same = candidates.find((e) => compareVersions(versionOf(e), versionOf(prev)) === 0);
            const pick = same ?? [...candidates].sort((a, b) => compareVersions(versionOf(b), versionOf(a)))[0];
            if (!pick) {
                failed.push({ ...ref(prev), error: "No published version of this app is left to install." });
                pending.delete(id);
                continue;
            }
            try {
                const r = await install(pick);
                if (!r.ok)
                    lastError.set(id, r.error ?? "install failed");
            }
            catch (err) {
                lastError.set(id, err instanceof Error ? err.message : String(err));
            }
        }
        after = await listAfter();
        let progress = false;
        for (const [id] of pending) {
            if (isInstalledNow(id)) {
                const now = after.find((e) => e.isInstalled && appIdOf(e) === id);
                reinstalled.push(ref(now));
                pending.delete(id);
                progress = true;
            }
        }
        if (!progress)
            break;
    }
    for (const [id, prev] of pending) {
        failed.push({ ...ref(prev), error: lastError.get(id) ?? "Still not installed after the reinstall passes." });
    }
    return {
        installedBefore: installedBefore.map(ref),
        uninstalledByPublish,
        reinstalled,
        failed,
        passes,
        installedAfter: after.filter((e) => e.isInstalled).map(ref),
    };
}
/** Install through the Automation API bound action extensions(<packageId>)/Microsoft.NAV.install. */
export function automationInstaller(t) {
    return async (ext) => {
        const res = await automationBoundAction(t.tenantId, t.environment, t.companyId, ext.packageId, "install");
        if (res.status >= 200 && res.status < 300)
            return { ok: true };
        return {
            ok: false,
            error: automationAuthError(res.status, res.body) ?? `Automation install HTTP ${res.status}: ${res.rawText.slice(0, 300)}`,
        };
    };
}
/** Install over Cosmo SSH (Sync-NAVApp + Install-NAVApp / Start-NAVAppDataUpgrade). */
export function sshInstaller(containerId, opts, deps = {}) {
    return async (ext) => {
        const r = await runContainerScript(containerId, buildInstallScript({ appId: ext.id ?? ext.packageId, version: versionOf(ext).join("."), tenant: opts.tenant }, { install: true }), { label: "install", sshUser: opts.sshUser, timeoutMs: opts.timeoutMs }, deps);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
    };
}
/** All extensions of the company (Automation API), for before/after snapshots. */
export function listAllExtensions(t) {
    return findExtensions(t.tenantId, t.environment, t.companyId, {});
}
/**
 * Automation API install of one app: picks the requested version (or the highest published one),
 * calls Microsoft.NAV.install and re-reads the extension list to confirm.
 */
export async function installViaAutomation(t, filter) {
    const matched = await findExtensions(t.tenantId, t.environment, t.companyId, filter);
    if (!matched.length) {
        return { ok: false, error: "No matching extension found via Automation API.", filter };
    }
    const installed = matched.find((m) => m.isInstalled);
    if (installed && (!filter.versionText || versionOf(installed).join(".") === filter.versionText)) {
        return { ok: true, via: "automation", alreadyInstalled: true, match: installed };
    }
    const pick = [...matched].sort((a, b) => compareVersions(versionOf(b), versionOf(a)))[0];
    const r = await automationInstaller(t)(pick);
    const after = await findExtensions(t.tenantId, t.environment, t.companyId, { appId: appIdOf(pick) });
    const ok = r.ok && after.some((e) => e.isInstalled && compareVersions(versionOf(e), versionOf(pick)) === 0);
    return {
        ok,
        via: "automation",
        action: "install",
        packageId: pick.packageId,
        match: pick,
        after,
        ...(r.error ? { error: r.error } : ok ? {} : { error: "Install call returned but the version is not installed." }),
        ...(installed && !ok
            ? { hint: `Version ${versionOf(installed).join(".")} is installed; an upgrade needs bc_dev_install_app via=ssh (Start-NAVAppDataUpgrade).` }
            : {}),
    };
}
//# sourceMappingURL=appLifecycle.js.map