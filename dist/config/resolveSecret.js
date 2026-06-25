import { spawnSync } from "node:child_process";
/**
 * Resolves a secret value from its stored form.
 *
 * Supported prefixes:
 *   env:<VAR_NAME>        — read from environment variable
 *   dpapi:<base64>        — DPAPI-unwrap (Windows only, CurrentUser scope)
 *   keychain:<service>    — read from macOS login Keychain
 *   plain:<value>         — strip prefix, use as-is (not secure at rest)
 *   (no prefix)           — literal value (backward compat)
 *
 * The same prefix conventions are used by the origo-bc-plugin stdio-proxy
 * (dynamics-is.js / Create-ConnectionString.ps1).
 */
export function resolveSecret(value) {
    if (!value)
        return value;
    const v = value.trim();
    if (v.startsWith("env:")) {
        return resolveEnv(v.slice("env:".length));
    }
    if (v.startsWith("dpapi:")) {
        return unwrapDpapi(v.slice("dpapi:".length));
    }
    if (v.startsWith("keychain:")) {
        return readKeychain(v.slice("keychain:".length));
    }
    if (v.startsWith("plain:")) {
        return v.slice("plain:".length);
    }
    // No prefix — literal value (backward compat).
    return value;
}
// ── Environment variable ──────────────────────────────────────────────────────
function resolveEnv(varName) {
    const name = varName.trim();
    const val = process.env[name];
    if (val === undefined) {
        throw new Error(`Secret references env:${name} but that environment variable is not set.`);
    }
    return val;
}
// ── DPAPI (Windows) ───────────────────────────────────────────────────────────
function unwrapDpapi(b64) {
    if (process.platform !== "win32") {
        throw new Error("dpapi: secrets are only supported on Windows.");
    }
    const script = "Add-Type -AssemblyName System.Security | Out-Null;" +
        "$enc = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
        "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect(" +
        "$enc, $null, " +
        "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
        "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($dec));";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { input: b64, encoding: "utf8", windowsHide: true });
    if (result.error) {
        throw new Error(`DPAPI unwrap: failed to launch PowerShell: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error("DPAPI unwrap failed (exit " +
            result.status +
            "). Value may have been encrypted for a different user/machine.");
    }
    const plain = (result.stdout ?? "").toString();
    if (!plain) {
        throw new Error("DPAPI unwrap produced empty output.");
    }
    return plain;
}
// ── macOS Keychain ────────────────────────────────────────────────────────────
function readKeychain(service) {
    if (process.platform !== "darwin") {
        throw new Error("keychain: secrets are only supported on macOS.");
    }
    const account = "mcp-encrypted-conn";
    const result = spawnSync("security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
        encoding: "utf8",
    });
    if (result.status !== 0) {
        const msg = (result.stderr ?? "").trim() || `security exited with ${result.status}`;
        throw new Error(`Keychain read failed for service "${service}": ${msg}`);
    }
    const value = (result.stdout ?? "").trim();
    if (!value) {
        throw new Error(`Keychain returned empty value for service "${service}".`);
    }
    return value;
}
//# sourceMappingURL=resolveSecret.js.map