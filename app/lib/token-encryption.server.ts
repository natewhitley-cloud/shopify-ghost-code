/**
 * Symmetric encryption for Shopify access tokens stored in the Shop model.
 *
 * Uses AES-256-GCM with a random IV per encryption. The encrypted output
 * format is: `iv:authTag:ciphertext` (all hex-encoded).
 *
 * Requires TOKEN_ENCRYPTION_KEY environment variable (64 hex chars = 32 bytes).
 * If the key is not set, encryption/decryption are no-ops (returns plaintext).
 * This allows local development without encryption while enforcing it in
 * production via Railway environment variables.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getKey(): Buffer | null {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes). " +
        `Got ${hex.length} characters.`,
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext token. Returns `iv:authTag:ciphertext` (hex).
 * If TOKEN_ENCRYPTION_KEY is not set, returns the plaintext unchanged.
 */
export function encryptToken(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt an encrypted token. Expects `iv:authTag:ciphertext` (hex).
 * If the input doesn't look encrypted (no colons), returns it unchanged
 * (handles migration from plaintext to encrypted tokens).
 * If TOKEN_ENCRYPTION_KEY is not set, returns the input unchanged.
 */
export function decryptToken(stored: string): string {
  const key = getKey();
  if (!key) return stored;

  // Plaintext tokens (pre-encryption migration) won't have the iv:tag:cipher format
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString("utf8");
}
