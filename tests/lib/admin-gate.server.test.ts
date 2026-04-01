/**
 * Tests for app/lib/admin-gate.server.ts
 *
 * Strategy:
 *   - Control process.env.ADMIN_SHOP_DOMAINS per test via vi.stubEnv.
 *   - Test case-insensitivity, whitespace handling, absent env var, empty list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { isAdminShop } from "../../app/lib/admin-gate.server";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isAdminShop", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when ADMIN_SHOP_DOMAINS is not set", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "");

    expect(isAdminShop("myshop.myshopify.com")).toBe(false);
  });

  it("returns false when ADMIN_SHOP_DOMAINS is undefined (env var absent)", () => {
    // Delete the env var entirely
    const original = process.env.ADMIN_SHOP_DOMAINS;
    delete process.env.ADMIN_SHOP_DOMAINS;

    expect(isAdminShop("myshop.myshopify.com")).toBe(false);

    // Restore
    if (original !== undefined) {
      process.env.ADMIN_SHOP_DOMAINS = original;
    }
  });

  it("returns false when ADMIN_SHOP_DOMAINS is only whitespace", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "   ");

    expect(isAdminShop("myshop.myshopify.com")).toBe(false);
  });

  it("returns true when domain matches exactly", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "myshop.myshopify.com");

    expect(isAdminShop("myshop.myshopify.com")).toBe(true);
  });

  it("returns true for a domain in a comma-separated list", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "first.myshopify.com,second.myshopify.com");

    expect(isAdminShop("second.myshopify.com")).toBe(true);
  });

  it("returns false for a domain not in the list", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "allowed.myshopify.com");

    expect(isAdminShop("notallowed.myshopify.com")).toBe(false);
  });

  it("is case-insensitive for the domain argument", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "myshop.myshopify.com");

    expect(isAdminShop("MYSHOP.MYSHOPIFY.COM")).toBe(true);
  });

  it("is case-insensitive for entries in ADMIN_SHOP_DOMAINS", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "MYSHOP.MYSHOPIFY.COM");

    expect(isAdminShop("myshop.myshopify.com")).toBe(true);
  });

  it("trims whitespace around entries in the env var", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "  myshop.myshopify.com  ,  other.myshopify.com  ");

    expect(isAdminShop("myshop.myshopify.com")).toBe(true);
    expect(isAdminShop("other.myshopify.com")).toBe(true);
  });

  it("handles a single-entry list with trailing comma gracefully", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "myshop.myshopify.com,");

    expect(isAdminShop("myshop.myshopify.com")).toBe(true);
  });

  it("does not treat an empty segment from a double-comma as a match for anything", () => {
    vi.stubEnv("ADMIN_SHOP_DOMAINS", "first.myshopify.com,,second.myshopify.com");

    // Empty string after split should not match a real domain
    expect(isAdminShop("")).toBe(false);
    expect(isAdminShop("first.myshopify.com")).toBe(true);
  });
});
