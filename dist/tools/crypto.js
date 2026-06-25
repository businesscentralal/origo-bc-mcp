/**
 * Crypto tools — encrypt_data, encode_base64, decode_base64.
 */
import { z } from "zod";
import { json } from "../bc/runtime.js";
import { getEncryptionKey } from "../config.js";
import { createCipheriv, randomBytes } from "crypto";
export function registerCryptoTools(server) {
    server.registerTool("encrypt_data", {
        title: "Encrypt data",
        description: "Encrypts a string with AES-256-GCM using the server's MCP_ENCRYPTION_KEY. " +
            "Returns base64-encoded ciphertext (IV + authTag + ciphertext).",
        inputSchema: {
            plaintext: z.string().describe("The text to encrypt."),
        },
    }, async ({ plaintext }) => {
        const key = getEncryptionKey();
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        const result = Buffer.concat([iv, tag, enc]).toString("base64");
        return json({ encrypted: result, algorithm: "AES-256-GCM", encoding: "base64" });
    });
    server.registerTool("encode_base64", {
        title: "Encode base64",
        description: "Encodes a string to base64.",
        inputSchema: {
            text: z.string().describe("Text to encode."),
        },
    }, async ({ text }) => {
        return json({ encoded: Buffer.from(text, "utf8").toString("base64") });
    });
    server.registerTool("decode_base64", {
        title: "Decode base64",
        description: "Decodes a base64 string to UTF-8 text.",
        inputSchema: {
            encoded: z.string().describe("Base64-encoded string."),
        },
    }, async ({ encoded }) => {
        return json({ decoded: Buffer.from(encoded, "base64").toString("utf8") });
    });
}
//# sourceMappingURL=crypto.js.map