/**
 * Shopify compliance tripwire (gc-5p4g): every install must hold an EXPIRING
 * offline access token by 2027-01-01 (delisting + no new installs otherwise;
 * Admin API 403s for non-expiring tokens from 2027-04-01). The library only
 * requests expiring tokens while this flag is on, so it must never be dropped.
 *
 * Prod check 2026-11-11: 11 active shops, 11 offline sessions, 0 without an
 * expiry or refresh token (no migration needed, gc-i29e closed).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("expiring offline access tokens", () => {
  it("a commented-out flag does not count (audit r4)", () => {
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const off = "future: {\n  // expiringOfflineAccessTokens: true,\n}";
    expect(strip(off)).not.toMatch(/future:\s*\{[^}]*expiringOfflineAccessTokens:\s*true/);
  });

  it("app/shopify.server.ts keeps future.expiringOfflineAccessTokens on", () => {
    const source = readFileSync(join(__dirname, "../../app/shopify.server.ts"), "utf8")
      // A commented-out flag is off (audit r4): drop comments first.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).toMatch(/future:\s*\{[^}]*expiringOfflineAccessTokens:\s*true/);
  });
});
