import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
    if (v.startsWith("aes:")) {
        return decryptAes(v.slice("aes:".length));
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
// ── AES-256-GCM (cross-platform, uses MCP_ENCRYPTION_KEY) ────────────────────
function getEncryptionKeyBuffer() {
    const hex = process.env.MCP_ENCRYPTION_KEY;
    if (!hex || hex.length !== 64) {
        throw new Error("aes: secrets require MCP_ENCRYPTION_KEY environment variable (64 hex chars = 32 bytes).");
    }
    return Buffer.from(hex, "hex");
}
function decryptAes(b64) {
    const key = getEncryptionKeyBuffer();
    const data = Buffer.from(b64, "base64");
    if (data.length < 28) {
        throw new Error("aes: ciphertext too short (expected IV + authTag + ciphertext).");
    }
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
}
/**
 * Encrypts a plaintext value with AES-256-GCM using MCP_ENCRYPTION_KEY.
 * Returns a string in the format "aes:<base64(IV + authTag + ciphertext)>".
 * Returns undefined if MCP_ENCRYPTION_KEY is not set (caller should fall back to plain:).
 */
export function encryptSecret(plaintext) {
    const hex = process.env.MCP_ENCRYPTION_KEY;
    if (!hex || hex.length !== 64)
        return undefined;
    const key = Buffer.from(hex, "hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, encrypted]).toString("base64");
    return `aes:${packed}`;
}
/**
 * Returns true if secrets can be encrypted at rest (MCP_ENCRYPTION_KEY is available).
 */
export function canEncryptSecrets() {
    const hex = process.env.MCP_ENCRYPTION_KEY;
    return Boolean(hex && hex.length === 64);
}
//# sourceMappingURL=resolveSecret.js.map