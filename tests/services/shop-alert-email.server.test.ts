/**
 * Tests for app/services/shop-alert-email.server.ts (gc-syz.2).
 * Both exports must NEVER throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetByDomain = vi.hoisted(() => vi.fn());
vi.mock("../../app/models/merchant-alert.server", () => ({
  setShopAlertEmailByDomain: mockSetByDomain,
}));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  fetchShopOwnerEmail,
  refreshShopAlertEmail,
} from "../../app/services/shop-alert-email.server";

const adminReturning = (body: unknown) => ({
  graphql: vi.fn().mockResolvedValue({ json: async () => body }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSetByDomain.mockResolvedValue(undefined);
});

describe("fetchShopOwnerEmail", () => {
  it("queries only shop { email } and returns the trimmed address", async () => {
    const admin = adminReturning({ data: { shop: { email: "  owner@example.com " } } });
    await expect(fetchShopOwnerEmail(admin)).resolves.toBe("owner@example.com");
    const query = admin.graphql.mock.calls[0][0] as string;
    expect(query).toMatch(/shop\s*{\s*email\s*}/);
  });

  it("returns null on GraphQL errors", async () => {
    const admin = adminReturning({ errors: [{ message: "boom" }], data: null });
    await expect(fetchShopOwnerEmail(admin)).resolves.toBeNull();
  });

  it.each([
    ["null email", { data: { shop: { email: null } } }],
    ["missing shop", { data: { shop: null } }],
    ["missing data", {}],
    ["blank email", { data: { shop: { email: "   " } } }],
    ["malformed email", { data: { shop: { email: "not-an-email" } } }],
    ["non-string email", { data: { shop: { email: 42 } } }],
    ["overlong email", { data: { shop: { email: `${"a".repeat(250)}@x.com` } } }],
  ])("returns null for %s", async (_label, body) => {
    await expect(fetchShopOwnerEmail(adminReturning(body))).resolves.toBeNull();
  });

  it("never throws when graphql rejects", async () => {
    const admin = { graphql: vi.fn().mockRejectedValue(new Error("network")) };
    await expect(fetchShopOwnerEmail(admin)).resolves.toBeNull();
  });

  it("never throws when the response body is not JSON", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => {
          throw new Error("bad json");
        },
      }),
    };
    await expect(fetchShopOwnerEmail(admin)).resolves.toBeNull();
  });
});

describe("refreshShopAlertEmail", () => {
  it("caches the fetched email by domain and returns it", async () => {
    const admin = adminReturning({ data: { shop: { email: "owner@example.com" } } });
    await expect(refreshShopAlertEmail("a.myshopify.com", admin)).resolves.toBe(
      "owner@example.com",
    );
    expect(mockSetByDomain).toHaveBeenCalledWith("a.myshopify.com", "owner@example.com");
  });

  it("returns null and leaves the cache untouched when no email is fetched", async () => {
    const admin = adminReturning({ data: { shop: { email: null } } });
    await expect(refreshShopAlertEmail("a.myshopify.com", admin)).resolves.toBeNull();
    expect(mockSetByDomain).not.toHaveBeenCalled();
  });

  it("returns null when the fetch throws, without writing", async () => {
    const admin = { graphql: vi.fn().mockRejectedValue(new Error("down")) };
    await expect(refreshShopAlertEmail("a.myshopify.com", admin)).resolves.toBeNull();
    expect(mockSetByDomain).not.toHaveBeenCalled();
  });

  it("never throws when the cache write fails, and still returns the email", async () => {
    mockSetByDomain.mockRejectedValue(new Error("db down"));
    const admin = adminReturning({ data: { shop: { email: "owner@example.com" } } });
    await expect(refreshShopAlertEmail("a.myshopify.com", admin)).resolves.toBe(
      "owner@example.com",
    );
  });
});
