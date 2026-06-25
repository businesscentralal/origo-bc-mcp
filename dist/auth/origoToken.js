import crypto from "node:crypto";
import { getEncryptionKey, config } from "../config.js";
/**
 * Decrypts an AES-256-GCM blob — EXACTLY the legacy server's format:
 *   base64( iv(12) ‖ authTag(16) ‖ ciphertext )
 * (see legacy mcpCodecTools.js: toolEncryptData).
 */
export function decryptCiphertext(b64) {
    const combined = Buffer.from(b64, "base64");
    if (combined.length < 12 + 16 + 1) {
        throw new Error("Ciphertext too short — expected iv(12) + tag(16) + data");
    }
    const iv = combined.subarray(0, 12);
    const tag = combined.subarray(12, 28);
    const enc = combined.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
}
/**
 * Parses x-origo-token (OpenClaw) into a BcConnection.
 * The token carries the same encrypted JSON blob as x-encrypted-conn:
 *   { tenantId, clientId, clientSecret, refreshToken, environment }
 */
export function connectionFromOrigoToken(token) {
    const raw = String(token).trim();
    if (raw.startsWith("plain:")) {
        throw new Error("Unencrypted 'plain:' tokens are not accepted. Provide an AES-256-GCM encrypted blob.");
    }
    let parsed;
    try {
        parsed = JSON.parse(decryptCiphertext(raw));
    }
    catch (e) {
        throw new Error(`x-origo-token could not be decrypted: ${e.message}`);
    }
    const tenantId = String(parsed.tenantId ?? "");
    if (!tenantId)
        throw new Error("x-origo-token blob is missing tenantId");
    return {
        tenantId,
        clientId: parsed.clientId ? String(parsed.clientId) : undefined,
        clientSecret: parsed.clientSecret ? String(parsed.clientSecret) : undefined,
        refreshToken: parsed.refreshToken ? String(parsed.refreshToken) : undefined,
        environment: parsed.environment ? String(parsed.environment) : config.defaultEnvironment,
    };
}
//# sourceMappingURL=origoToken.js.map