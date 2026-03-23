/**
 * Tests for the installed-app model functions.
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each function in isolation — no Shopify SDK involvement.
 *
 * Note: Shopify does NOT provide webhooks for tracking other apps being
 * installed/uninstalled on a merchant's store. The InstalledApp model is
 * populated by the permission-fetcher sync function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  installedApp: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  upsertInstalledApp,
  markAppRemoved,
  getInstalledApps,
  getInstalledAppByHandle,
  getRemovedApps,
} from "../../app/models/installed-app.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-abc";
const APP_DATA = {
  shopifyAppId: "gid://shopify/App/123",
  appHandle: "some-app",
  appName: "Some App",
  appDescription: "Does things",
  publicCategory: "Marketing",
};

function makeInstalledApp(overrides: Record<string, unknown> = {}) {
  return {
    id: "ia-1",
    shopId: SHOP_ID,
    shopifyAppId: APP_DATA.shopifyAppId,
    appHandle: APP_DATA.appHandle,
    appName: APP_DATA.appName,
    appDescription: APP_DATA.appDescription,
    publicCategory: APP_DATA.publicCategory,
    presence: "INSTALLED",
    firstSeenAt: new Date("2026-01-01"),
    lastSeenAt: new Date("2026-03-21"),
    removedAt: null,
    hasActiveSubscription: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// upsertInstalledApp
// ---------------------------------------------------------------------------

describe("upsertInstalledApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new record when the app does not exist", async () => {
    const created = makeInstalledApp();
    mockDb.installedApp.upsert.mockResolvedValue(created);

    const result = await upsertInstalledApp(SHOP_ID, APP_DATA);

    expect(mockDb.installedApp.upsert).toHaveBeenCalledOnce();
    const call = mockDb.installedApp.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      shopId_shopifyAppId: {
        shopId: SHOP_ID,
        shopifyAppId: APP_DATA.shopifyAppId,
      },
    });
    expect(call.create.shopId).toBe(SHOP_ID);
    expect(call.create.appHandle).toBe(APP_DATA.appHandle);
    expect(call.create.appName).toBe(APP_DATA.appName);
    expect(call.create.presence).toBe("INSTALLED");
    expect(call.create.lastSeenAt).toBeInstanceOf(Date);
    expect(result).toEqual(created);
  });

  it("updates an existing record (idempotent upsert)", async () => {
    const updated = makeInstalledApp({ appName: "Some App v2" });
    mockDb.installedApp.upsert.mockResolvedValue(updated);

    const result = await upsertInstalledApp(SHOP_ID, {
      ...APP_DATA,
      appName: "Some App v2",
    });

    const call = mockDb.installedApp.upsert.mock.calls[0][0];
    expect(call.update.appName).toBe("Some App v2");
    expect(call.update.presence).toBe("INSTALLED");
    expect(call.update.removedAt).toBeNull();
    expect(call.update.lastSeenAt).toBeInstanceOf(Date);
    expect(result.appName).toBe("Some App v2");
  });

  it("defaults optional fields to null when not provided", async () => {
    const minimal = makeInstalledApp({
      appDescription: null,
      publicCategory: null,
    });
    mockDb.installedApp.upsert.mockResolvedValue(minimal);

    await upsertInstalledApp(SHOP_ID, {
      shopifyAppId: APP_DATA.shopifyAppId,
      appHandle: APP_DATA.appHandle,
      appName: APP_DATA.appName,
    });

    const call = mockDb.installedApp.upsert.mock.calls[0][0];
    expect(call.create.appDescription).toBeNull();
    expect(call.create.publicCategory).toBeNull();
    expect(call.update.appDescription).toBeNull();
    expect(call.update.publicCategory).toBeNull();
  });

  it("re-installs a previously removed app (resets presence and removedAt)", async () => {
    const reinstalled = makeInstalledApp({ presence: "INSTALLED", removedAt: null });
    mockDb.installedApp.upsert.mockResolvedValue(reinstalled);

    const result = await upsertInstalledApp(SHOP_ID, APP_DATA);

    const call = mockDb.installedApp.upsert.mock.calls[0][0];
    expect(call.update.presence).toBe("INSTALLED");
    expect(call.update.removedAt).toBeNull();
    expect(result.presence).toBe("INSTALLED");
  });

  it("propagates database errors", async () => {
    mockDb.installedApp.upsert.mockRejectedValueOnce(new Error("unique constraint"));

    await expect(upsertInstalledApp(SHOP_ID, APP_DATA)).rejects.toThrow("unique constraint");
  });
});

// ---------------------------------------------------------------------------
// markAppRemoved
// ---------------------------------------------------------------------------

describe("markAppRemoved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets presence to REMOVED and records removedAt", async () => {
    const existing = makeInstalledApp();
    mockDb.installedApp.findUnique.mockResolvedValue(existing);
    const removed = makeInstalledApp({
      presence: "REMOVED",
      removedAt: new Date("2026-03-21"),
    });
    mockDb.installedApp.update.mockResolvedValue(removed);

    const result = await markAppRemoved(SHOP_ID, APP_DATA.shopifyAppId);

    expect(mockDb.installedApp.findUnique).toHaveBeenCalledWith({
      where: {
        shopId_shopifyAppId: {
          shopId: SHOP_ID,
          shopifyAppId: APP_DATA.shopifyAppId,
        },
      },
    });
    expect(mockDb.installedApp.update).toHaveBeenCalledOnce();
    const updateCall = mockDb.installedApp.update.mock.calls[0][0];
    expect(updateCall.data.presence).toBe("REMOVED");
    expect(updateCall.data.removedAt).toBeInstanceOf(Date);
    expect(result?.presence).toBe("REMOVED");
  });

  it("returns null when the app record does not exist", async () => {
    mockDb.installedApp.findUnique.mockResolvedValue(null);

    const result = await markAppRemoved(SHOP_ID, "gid://shopify/App/nonexistent");

    expect(result).toBeNull();
    expect(mockDb.installedApp.update).not.toHaveBeenCalled();
  });

  it("propagates database errors from update", async () => {
    mockDb.installedApp.findUnique.mockResolvedValue(makeInstalledApp());
    mockDb.installedApp.update.mockRejectedValueOnce(new Error("DB write failed"));

    await expect(markAppRemoved(SHOP_ID, APP_DATA.shopifyAppId)).rejects.toThrow("DB write failed");
  });
});

// ---------------------------------------------------------------------------
// getInstalledApps
// ---------------------------------------------------------------------------

describe("getInstalledApps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only INSTALLED apps for the given shop", async () => {
    const apps = [
      makeInstalledApp({ id: "ia-1", appName: "Alpha" }),
      makeInstalledApp({ id: "ia-2", appName: "Beta" }),
    ];
    mockDb.installedApp.findMany.mockResolvedValue(apps);

    const result = await getInstalledApps(SHOP_ID);

    expect(mockDb.installedApp.findMany).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        presence: "INSTALLED",
      },
      orderBy: { appName: "asc" },
    });
    expect(result).toHaveLength(2);
  });

  it("returns an empty array when no apps are installed", async () => {
    mockDb.installedApp.findMany.mockResolvedValue([]);

    const result = await getInstalledApps(SHOP_ID);

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getInstalledAppByHandle
// ---------------------------------------------------------------------------

describe("getInstalledAppByHandle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the app when found by handle", async () => {
    const app = makeInstalledApp();
    mockDb.installedApp.findFirst.mockResolvedValue(app);

    const result = await getInstalledAppByHandle(SHOP_ID, "some-app");

    expect(mockDb.installedApp.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        appHandle: "some-app",
      },
    });
    expect(result).toEqual(app);
  });

  it("returns null when no app matches the handle", async () => {
    mockDb.installedApp.findFirst.mockResolvedValue(null);

    const result = await getInstalledAppByHandle(SHOP_ID, "nonexistent-app");

    expect(result).toBeNull();
  });

  it("does not filter by presence (returns removed apps too)", async () => {
    const removedApp = makeInstalledApp({ presence: "REMOVED" });
    mockDb.installedApp.findFirst.mockResolvedValue(removedApp);

    const result = await getInstalledAppByHandle(SHOP_ID, "some-app");

    // Verify the query does NOT include a presence filter
    expect(mockDb.installedApp.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        appHandle: "some-app",
      },
    });
    expect(result?.presence).toBe("REMOVED");
  });
});

// ---------------------------------------------------------------------------
// getRemovedApps
// ---------------------------------------------------------------------------

describe("getRemovedApps", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns only REMOVED apps for the given shop", async () => {
    const apps = [
      makeInstalledApp({
        id: "ia-1",
        appName: "Old App",
        presence: "REMOVED",
        removedAt: new Date("2026-03-20"),
      }),
      makeInstalledApp({
        id: "ia-2",
        appName: "Older App",
        presence: "REMOVED",
        removedAt: new Date("2026-03-15"),
      }),
    ];
    mockDb.installedApp.findMany.mockResolvedValue(apps);

    const result = await getRemovedApps(SHOP_ID);

    expect(mockDb.installedApp.findMany).toHaveBeenCalledWith({
      where: {
        shopId: SHOP_ID,
        presence: "REMOVED",
      },
      orderBy: { removedAt: "desc" },
    });
    expect(result).toHaveLength(2);
  });

  it("returns an empty array when no removed apps exist", async () => {
    mockDb.installedApp.findMany.mockResolvedValue([]);

    const result = await getRemovedApps(SHOP_ID);

    expect(result).toEqual([]);
  });
});
