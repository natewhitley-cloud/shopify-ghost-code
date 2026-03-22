import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptToken, decryptToken } from "../../app/lib/token-encryption.server";

// A valid 32-byte key (64 hex chars)
const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("token-encryption", () => {
  const originalEnv = process.env.TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TOKEN_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  describe("with encryption key set", () => {
    beforeEach(() => {
      process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    });

    it("encrypts and decrypts a token round-trip", () => {
      const plaintext = "shpat_abc123_test_token";
      const encrypted = encryptToken(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.split(":")).toHaveLength(3);

      const decrypted = decryptToken(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for the same input (random IV)", () => {
      const plaintext = "shpat_same_token";
      const a = encryptToken(plaintext);
      const b = encryptToken(plaintext);
      expect(a).not.toBe(b);

      expect(decryptToken(a)).toBe(plaintext);
      expect(decryptToken(b)).toBe(plaintext);
    });

    it("decrypts plaintext tokens unchanged (migration support)", () => {
      const plaintext = "shpat_old_plaintext_token";
      // No colons — treated as pre-encryption plaintext
      expect(decryptToken(plaintext)).toBe(plaintext);
    });

    it("handles empty string", () => {
      const encrypted = encryptToken("");
      const decrypted = decryptToken(encrypted);
      expect(decrypted).toBe("");
    });
  });

  describe("without encryption key", () => {
    beforeEach(() => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    });

    it("encryptToken returns plaintext unchanged", () => {
      const plaintext = "shpat_no_key_token";
      expect(encryptToken(plaintext)).toBe(plaintext);
    });

    it("decryptToken returns input unchanged", () => {
      const input = "shpat_no_key_token";
      expect(decryptToken(input)).toBe(input);
    });
  });

  describe("invalid key", () => {
    it("throws if key is wrong length", () => {
      process.env.TOKEN_ENCRYPTION_KEY = "tooshort";
      expect(() => encryptToken("test")).toThrow("must be 64 hex characters");
    });
  });
});
