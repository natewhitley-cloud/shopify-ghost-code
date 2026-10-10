/**
 * Tests for app/services/shop-alert-email.server.ts (gc-syz.2, gc-ol95): the
 * owner email + store name read and cache. Every export must NEVER throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetByDomain = vi.hoisted(() => vi.fn());
vi.mock("../../app/models/merchant-alert.server", () => ({
  setShopContactByDomain: mockSetByDomain,
}));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  fetchShopContact,
  refreshShopAlertEmail,
  refreshShopContact,
} from "../../app/services/shop-alert-email.server";

const adminReturning = (body: unknown) => ({
  graphql: vi.fn().mockResolvedValue({ json: async () => body }),
});
const NONE = { email: null, storeName: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockSetByDomain.mockResolvedValue(undefined);
});

describe("fetchShopContact", () => {
  it("reads shop { email name } in ONE query and returns both trimmed", async () => {
    const admin = adminReturning({
      data: { shop: { email: "  owner@example.com ", name: "  Paw Naturals " } },
    });
    await expect(fetchShopContact(admin)).resolves.toEqual({
      email: "owner@example.com",
      storeName: "Paw Naturals",
    });
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    const query = admin.graphql.mock.calls[0][0] as string;
    expect(query).toMatch(/shop\s*{\s*email\s+name\s*}/);
  });

  it("returns both null on GraphQL errors", async () => {
    const admin = adminReturning({ errors: [{ message: "boom" }], data: null });
    await expect(fetchShopContact(admin)).resolves.toEqual(NONE);
  });

  it.each([
    ["null email", { data: { shop: { email: null, name: "S" } } }],
    ["blank email", { data: { shop: { email: "   ", name: "S" } } }],
    ["malformed email", { data: { shop: { email: "not-an-email", name: "S" } } }],
    ["non-string email", { data: { shop: { email: 42, name: "S" } } }],
    ["overlong email", { data: { shop: { email: `${"a".repeat(250)}@x.com`, name: "S" } } }],
  ])("email is null for %s; the name is still read", async (_label, body) => {
    await expect(fetchShopContact(adminReturning(body))).resolves.toEqual({
      email: null,
      storeName: "S",
    });
  });

  it.each([
    ["null name", null],
    ["blank name", "   "],
    ["non-string name", 42],
    ["missing name", undefined],
  ])("store name is null for %s; the email is still read", async (_label, name) => {
    const admin = adminReturning({ data: { shop: { email: "o@example.com", name } } });
    await expect(fetchShopContact(admin)).resolves.toEqual({
      email: "o@example.com",
      storeName: null,
    });
  });

  it("caps an overlong store name at 255 characters", async () => {
    const admin = adminReturning({ data: { shop: { email: null, name: "x".repeat(400) } } });
    expect((await fetchShopContact(admin)).storeName).toHaveLength(255);
  });

  it.each([
    ["missing shop", { data: { shop: null } }],
    ["missing data", {}],
  ])("returns both null for %s", async (_label, body) => {
    await expect(fetchShopContact(adminReturning(body))).resolves.toEqual(NONE);
  });

  it("never throws when graphql rejects", async () => {
    const admin = { graphql: vi.fn().mockRejectedValue(new Error("network")) };
    await expect(fetchShopContact(admin)).resolves.toEqual(NONE);
  });

  it("never throws when the response body is not JSON", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => {
          throw new Error("bad json");
        },
      }),
    };
    await expect(fetchShopContact(admin)).resolves.toEqual(NONE);
  });
});

describe("refreshShopContact", () => {
  it("caches the fetched email and store name by domain and returns them", async () => {
    const contact = { email: "owner@example.com", storeName: "Paw Naturals" };
    const admin = adminReturning({
      data: { shop: { email: contact.email, name: "Paw Naturals" } },
    });
    await expect(refreshShopContact("a.myshopify.com", admin)).resolves.toEqual(contact);
    expect(mockSetByDomain).toHaveBeenCalledWith("a.myshopify.com", contact);
  });

  it("caches the name even when no email is read (null fields are never cleared)", async () => {
    const admin = adminReturning({ data: { shop: { email: null, name: "Paw Naturals" } } });
    await expect(refreshShopContact("a.myshopify.com", admin)).resolves.toEqual({
      email: null,
      storeName: "Paw Naturals",
    });
    expect(mockSetByDomain).toHaveBeenCalledWith("a.myshopify.com", {
      email: null,
      storeName: "Paw Naturals",
    });
  });

  it("writes nothing when nothing is read", async () => {
    const admin = adminReturning({ data: { shop: { email: null, name: null } } });
    await expect(refreshShopContact("a.myshopify.com", admin)).resolves.toEqual(NONE);
    expect(mockSetByDomain).not.toHaveBeenCalled();
  });

  it("returns both null when the fetch throws, without writing", async () => {
    const admin = { graphql: vi.fn().mockRejectedValue(new Error("down")) };
    await expect(refreshShopContact("a.myshopify.com", admin)).resolves.toEqual(NONE);
    expect(mockSetByDomain).not.toHaveBeenCalled();
  });

  it("never throws when the cache write fails, and still returns what it read", async () => {
    mockSetByDomain.mockRejectedValue(new Error("db down"));
    const admin = adminReturning({ data: { shop: { email: "owner@example.com", name: "S" } } });
    await expect(refreshShopContact("a.myshopify.com", admin)).resolves.toEqual({
      email: "owner@example.com",
      storeName: "S",
    });
  });
});

describe("refreshShopAlertEmail", () => {
  it("returns the email and still refreshes the store name in the cache", async () => {
    const admin = adminReturning({ data: { shop: { email: "owner@example.com", name: "S" } } });
    await expect(refreshShopAlertEmail("a.myshopify.com", admin)).resolves.toBe(
      "owner@example.com",
    );
    expect(mockSetByDomain).toHaveBeenCalledWith("a.myshopify.com", {
      email: "owner@example.com",
      storeName: "S",
    });
  });

  it("returns null when no email is read", async () => {
    const admin = adminReturning({ data: { shop: { email: null, name: null } } });
    await expect(refreshShopAlertEmail("a.myshopify.com", admin)).resolves.toBeNull();
  });
});
