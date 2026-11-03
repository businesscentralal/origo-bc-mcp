/**
 * Premium plan for users of a Cosmo BC container (Docker, no Office 365).
 *
 * Why: Cosmo's enablePremium flag does not give the default admin user a Premium licence inside
 * BC, so Company Information → Experience = Premium fails with "you do not have a Premium license
 * assigned to you". On a container the plan has to be assigned inside BC's own database, which is
 * what BcContainerHelper does for `New-BcContainer -assignPremiumPlan` and
 * `New-BcContainerBcUser -assignPremiumPlan`:
 *
 *   microsoft/navcontainerhelper @ 850952c7eaf6730ee118bab909b4a92a9013dfb8
 *   - ContainerHandling/New-NavContainer.ps1 lines 1588-1617: every user of tenant `default` whose
 *     LicenseType is "FullUser" ("Full User" from BC 29) gets
 *       INSERT INTO [dbo].[User Plan$63ca2fa4-4f03-4f2b-a480-172fef340d3f] ([Plan ID],[User Security ID])
 *       VALUES ('{8e9002c0-a1d8-4465-b952-817d2948e6e2}','<UserSecurityId>')
 *     (table `User Plan` without the app id suffix before BC 15), via
 *     Invoke-Sqlcmd -ServerInstance 'localhost\SQLEXPRESS', database = DatabaseName, or the
 *     tenant id when the container is multitenant.
 *   - UserHandling/New-NavContainerNavUser.ps1 lines 81-104 (reads Multitenant / DatabaseName /
 *     DatabaseServer / DatabaseInstance from the service's CustomSettings.config) and lines
 *     127-139 (database = (Get-NavTenant -Tenant $tenant).DatabaseName when multitenant; inserts
 *     the same row into both table names with -ErrorAction Ignore).
 *
 * BcContainerHelper never removes the Essential plan row, so neither does this. Differences, all
 * for safety/idempotency: the insert is guarded by IF NOT EXISTS, the table name is picked by
 * looking in sys.tables instead of guessing from the version, and errors are reported instead of
 * ignored. Setting the company's Experience is NOT done here: the supported path is the
 * Company Information page / "Application Area Mgmt. Facade", which also rebuilds the
 * Application Area Setup; writing Experience Tier Setup with SQL would skip that.
 */
import { escPs, PS_PREAMBLE, runContainerScript } from "./containerScript.js";
import { cosmoRequest } from "../cosmo/client.js";
/** Plan id of "Dynamics 365 Business Central Premium" (BcContainerHelper, System Application Plan). */
export const PREMIUM_PLAN_ID = "8e9002c0-a1d8-4465-b952-817d2948e6e2";
/** System Application (Microsoft) app id; suffix of its company-independent SQL table names. */
export const SYSTEM_APP_ID = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
const TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** PowerShell script: find users + tenant database, insert the Premium User Plan row idempotently. */
export function buildAssignPremiumPlanScript(opts = {}) {
    const tenant = opts.tenant?.trim() || "default";
    if (!TENANT_RE.test(tenant))
        throw new Error(`tenant must be letters, digits, '-' or '_', got '${tenant}'.`);
    const userName = opts.userName?.trim() ?? "";
    if (userName.length > 250)
        throw new Error("userName is too long.");
    const waitSeconds = Math.max(0, Math.min(Math.round(opts.waitForServerSeconds ?? 60), 1800));
    return [
        ...PS_PREAMBLE,
        `$tenant = '${escPs(tenant)}'`,
        `$userFilter = '${escPs(userName)}'`,
        `$dryRun = $${opts.dryRun ? "true" : "false"}`,
        `$waitSeconds = ${waitSeconds}`,
        `$premiumPlanId = '${PREMIUM_PLAN_ID}'`,
        `$knownPlans = @{ '${PREMIUM_PLAN_ID}' = 'Dynamics 365 Business Central Premium'; '920656a2-7dd8-4c83-97b6-a356f2b4a0a0' = 'Dynamics 365 Business Central Essential'; 'd9a6391b-8970-4976-bd94-5f205007c8d8' = 'Dynamics 365 Business Central Team Member' }`,
        "$steps = New-Object System.Collections.Generic.List[string]",
        "function IsFullUser($u) { (\"$($u.LicenseType)\" -replace ' ', '') -eq 'FullUser' }",
        "function UserInfo($u) { [ordered]@{ userName = \"$($u.UserName)\"; userSecurityId = \"$($u.UserSecurityId)\".Trim('{}').ToLower(); state = \"$($u.State)\"; licenseType = \"$($u.LicenseType)\" } }",
        // 1. users (the server instance may still be starting right after the container came up)
        "$deadline = (Get-Date).AddSeconds($waitSeconds)",
        "$users = $null; $lastErr = $null",
        "while ($true) {",
        "  try { $users = @(Get-NAVServerUser -ServerInstance $si -Tenant $tenant -ErrorAction Stop); $lastErr = $null } catch { $users = $null; $lastErr = $_.Exception.Message }",
        "  if ($users -and $users.Count) { break }",
        "  if ((Get-Date) -ge $deadline) { break }",
        "  Start-Sleep -Seconds 10",
        "}",
        "if ($null -eq $users) { Emit @{ ok = $false; failedStep = 'users'; error = \"Get-NAVServerUser failed on tenant ${tenant}: $lastErr\" }; exit 4 }",
        "if ($userFilter) {",
        "  $selected = @($users | Where-Object { $_.UserName -eq $userFilter -or \"$($_.UserName)\".EndsWith(\"\\$userFilter\", [System.StringComparison]::InvariantCultureIgnoreCase) })",
        "  if (-not $selected.Count) { Emit @{ ok = $false; failedStep = 'users'; error = \"No BC user named '$userFilter' on tenant $tenant.\"; users = @($users | ForEach-Object { UserInfo $_ }) }; exit 4 }",
        "} else {",
        "  $selected = @($users | Where-Object { \"$($_.State)\" -eq 'Enabled' -and (IsFullUser $_) })",
        "  if (-not $selected.Count) { Emit @{ ok = $false; failedStep = 'users'; error = \"No enabled Full User on tenant $tenant (pass userName to pick one).\"; users = @($users | ForEach-Object { UserInfo $_ }) }; exit 4 }",
        "}",
        // 2. tenant database (BcContainerHelper New-NavContainerNavUser.ps1 lines 83-91, 131-134)
        "try {",
        "  $cfgFile = Get-ChildItem 'C:\\Program Files\\Microsoft Dynamics NAV\\*\\Service\\CustomSettings.config' -ErrorAction Stop | Select-Object -First 1",
        "  [xml]$cfg = [System.IO.File]::ReadAllText($cfgFile.FullName)",
        "  function Cfg($k) { $n = $cfg.SelectSingleNode(\"//appSettings/add[@key='$k']\"); if ($n) { \"$($n.Value)\" } else { '' } }",
        "  $multitenant = (Cfg 'Multitenant') -eq 'true'",
        "  $dbName = Cfg 'DatabaseName'",
        "  $sqlServer = Cfg 'DatabaseServer'",
        "  if (-not $sqlServer) { $sqlServer = 'localhost' }",
        "  $dbInstance = Cfg 'DatabaseInstance'",
        "  if ($dbInstance) { $sqlServer += \"\\$dbInstance\" }",
        "  if ($multitenant) { $dbName = (Get-NAVTenant -ServerInstance $si -Tenant $tenant -ErrorAction Stop).DatabaseName }",
        "  if (-not $dbName) { throw 'No database name found (CustomSettings.config DatabaseName / Get-NAVTenant).' }",
        "} catch { Emit @{ ok = $false; failedStep = 'database'; error = $_.Exception.Message }; exit 5 }",
        "$steps.Add(\"database $dbName on $sqlServer (multitenant=$multitenant)\")",
        // 3. Invoke-Sqlcmd (SqlServer or sqlps module, as BcContainerHelper uses inside the container)
        "if (-not (Get-Command Invoke-Sqlcmd -ErrorAction SilentlyContinue)) {",
        "  foreach ($m in @('SqlServer', 'sqlps')) {",
        "    Push-Location",
        "    try { Import-Module $m -DisableNameChecking -ErrorAction Stop -WarningAction SilentlyContinue } catch { } finally { Pop-Location }",
        "    if (Get-Command Invoke-Sqlcmd -ErrorAction SilentlyContinue) { break }",
        "  }",
        "}",
        "if (-not (Get-Command Invoke-Sqlcmd -ErrorAction SilentlyContinue)) { Emit @{ ok = $false; failedStep = 'sql'; error = 'Invoke-Sqlcmd is not available in the container (no SqlServer/sqlps module).' }; exit 5 }",
        "$sqlParams = @{ ServerInstance = $sqlServer; Database = $dbName; ErrorAction = 'Stop' }",
        "if ((Get-Command Invoke-Sqlcmd).Parameters.ContainsKey('TrustServerCertificate')) { $sqlParams.TrustServerCertificate = $true }",
        // Leading comma: return the row array as one object so an empty result stays an empty array.
        "function Sql($q) { ,@(Invoke-Sqlcmd @sqlParams -Query $q) }",
        `$upNew = 'User Plan$${SYSTEM_APP_ID}'`,
        `$planNew = 'Plan$${SYSTEM_APP_ID}'`,
        "try {",
        "  $names = @((Sql \"SELECT name FROM sys.tables WHERE name IN (N'$upNew', N'User Plan', N'$planNew', N'Plan')\") | ForEach-Object { \"$($_.name)\" })",
        "} catch { Emit @{ ok = $false; failedStep = 'sql'; error = \"SQL connection to $sqlServer / $dbName failed: $($_.Exception.Message)\"; hint = 'BcContainerHelper only supports localhost\\SQLEXPRESS without database credentials; a foreign SQL server needs a SQL login.' }; exit 5 }",
        "if ($names -contains $upNew) { $userPlanTable = $upNew } elseif ($names -contains 'User Plan') { $userPlanTable = 'User Plan' } else { Emit @{ ok = $false; failedStep = 'sql'; error = \"No User Plan table in database $dbName.\" }; exit 5 }",
        "if ($names -contains $planNew) { $planTable = $planNew } elseif ($names -contains 'Plan') { $planTable = 'Plan' } else { $planTable = $null }",
        "function PlanName($id, $name) { if ($name -and -not ($name -is [System.DBNull])) { \"$name\" } elseif ($knownPlans.ContainsKey($id)) { $knownPlans[$id] } else { '' } }",
        "function Plans($uid) {",
        "  $rows = $null",
        "  if ($planTable) {",
        "    try { $rows = Sql (\"SELECT CONVERT(nvarchar(36), up.[Plan ID]) AS PlanId, p.[Name] AS PlanName FROM [dbo].[\" + $userPlanTable + \"] up LEFT JOIN [dbo].[\" + $planTable + \"] p ON p.[Plan ID] = up.[Plan ID] WHERE up.[User Security ID] = '\" + $uid + \"'\") } catch { $script:planTable = $null }",
        "  }",
        "  if ($null -eq $rows) { $rows = Sql (\"SELECT CONVERT(nvarchar(36), up.[Plan ID]) AS PlanId, NULL AS PlanName FROM [dbo].[\" + $userPlanTable + \"] up WHERE up.[User Security ID] = '\" + $uid + \"'\") }",
        "  ,@($rows | ForEach-Object { $id = \"$($_.PlanId)\".ToLower(); [ordered]@{ planId = $id; name = (PlanName $id $_.PlanName) } })",
        "}",
        // 4. per user: before → insert if missing → after
        "$result = New-Object System.Collections.Generic.List[object]",
        "try {",
        "  foreach ($u in $selected) {",
        "    $uid = ([guid]\"$($u.UserSecurityId)\").ToString()",
        "    $info = UserInfo $u",
        "    $before = Plans $uid",
        "    $has = @($before | Where-Object { $_.planId -eq $premiumPlanId }).Count -gt 0",
        "    if ($has) { $action = 'alreadyPremium' }",
        "    elseif ($dryRun) { $action = 'wouldInsert' }",
        "    else {",
        "      Sql (\"IF NOT EXISTS (SELECT 1 FROM [dbo].[\" + $userPlanTable + \"] WHERE [Plan ID] = '\" + $premiumPlanId + \"' AND [User Security ID] = '\" + $uid + \"') INSERT INTO [dbo].[\" + $userPlanTable + \"] ([Plan ID],[User Security ID]) VALUES ('\" + $premiumPlanId + \"','\" + $uid + \"')\") | Out-Null",
        "      $action = 'inserted'",
        "    }",
        "    if ($action -eq 'inserted') { $after = Plans $uid } else { $after = $before }",
        "    $info.action = $action; $info.before = @($before); $info.after = @($after)",
        "    $info.premiumAfter = @($after | Where-Object { $_.planId -eq $premiumPlanId }).Count -gt 0",
        "    $result.Add($info)",
        "  }",
        "} catch { Emit @{ ok = $false; failedStep = 'assign'; error = $_.Exception.Message; users = $result; steps = $steps }; exit 6 }",
        "$missing = @($result | Where-Object { -not $_.premiumAfter }).Count",
        "Emit @{ ok = ($dryRun -or $missing -eq 0); serverInstance = $si; tenant = $tenant; database = $dbName; sqlServer = $sqlServer; multitenant = $multitenant; userPlanTable = $userPlanTable; premiumPlanId = $premiumPlanId; dryRun = $dryRun; users = $result; steps = $steps }",
        "exit 0",
    ].join("\n");
}
export const PREMIUM_NEXT_STEPS = "Sign out and back in to BC (new session), then Company Information → Experience = Premium. " +
    "The Essential plan row is left in place, as BcContainerHelper does.";
/** Runs the Premium plan script in the container over Cosmo SSH. */
export async function assignPremiumPlan(containerId, opts, deps = {}) {
    const script = buildAssignPremiumPlanScript(opts);
    const r = await runContainerScript(containerId, script, {
        label: "premium",
        sshUser: opts.sshUser,
        timeoutMs: opts.timeoutMs,
        sshWaitSeconds: opts.sshWaitSeconds,
        allowRestart: opts.allowRestart,
    }, deps);
    return r.ok && !opts.dryRun ? { ...r, nextSteps: PREMIUM_NEXT_STEPS } : r;
}
export async function getContainerState(containerId, backendUrl) {
    const res = await cosmoRequest("GET", `/Container/Container/${encodeURIComponent(containerId)}`, { backendUrl });
    const status = res.body?.status;
    return typeof status?.state === "string" ? status.state : undefined;
}
/** Polls the Cosmo container until status.state is Running or the time budget is spent. */
export async function waitForContainerRunning(containerId, opts, deps = {}) {
    const getState = deps.getState ?? getContainerState;
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;
    const start = now();
    const budgetMs = Math.max(0, opts.timeoutSeconds) * 1000;
    const pollMs = Math.max(1, opts.pollSeconds ?? 15) * 1000;
    const progress = [];
    let state;
    for (;;) {
        try {
            state = await getState(containerId, opts.backendUrl);
        }
        catch {
            state = undefined;
        }
        const label = state ?? "unknown";
        if (!progress.length || progress[progress.length - 1].state !== label) {
            progress.push({ atMs: now() - start, state: label });
        }
        if (state === "Running")
            return { running: true, state, elapsedMs: now() - start, progress };
        const left = budgetMs - (now() - start);
        if (left <= 0)
            return { running: false, state, elapsedMs: now() - start, progress };
        await sleep(Math.min(pollMs, left));
    }
}
/**
 * After cosmo_create_container: wait for Running, then assign the Premium plan over SSH.
 * Never throws; a timeout comes back as a hint to call bc_dev_assign_premium_plan later.
 */
export async function premiumAfterCreate(containerId, opts, deps = {}) {
    const waited = await waitForContainerRunning(containerId, { timeoutSeconds: opts.waitTimeoutSeconds, pollSeconds: opts.pollSeconds, backendUrl: opts.backendUrl }, deps);
    if (!waited.running) {
        return {
            assigned: false,
            containerId,
            containerState: waited.state ?? "unknown",
            waitedMs: waited.elapsedMs,
            progress: waited.progress,
            hint: `Container ${containerId} is not Running yet (state ${waited.state ?? "unknown"} after ` +
                `${Math.round(waited.elapsedMs / 1000)} s). When cosmo_get_container shows Running, call ` +
                `bc_dev_assign_premium_plan with containerId=${containerId}.`,
        };
    }
    try {
        const r = await assignPremiumPlan(containerId, { userName: opts.userName, waitForServerSeconds: opts.waitForServerSeconds ?? 600, sshWaitSeconds: 600 }, deps);
        return {
            assigned: r.ok,
            containerId,
            containerState: waited.state,
            waitedMs: waited.elapsedMs,
            progress: waited.progress,
            result: r,
            ...(r.ok
                ? {}
                : { hint: `Premium plan assignment failed; fix the error and call bc_dev_assign_premium_plan with containerId=${containerId}.` }),
        };
    }
    catch (err) {
        return {
            assigned: false,
            containerId,
            containerState: waited.state,
            error: err instanceof Error ? err.message : String(err),
            hint: `Call bc_dev_assign_premium_plan with containerId=${containerId}.`,
        };
    }
}
//# sourceMappingURL=premiumPlan.js.map