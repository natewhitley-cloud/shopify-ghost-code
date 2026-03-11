/**
 * Tests for the poll-theme-changes Inngest cron function.
 *
 * Strategy:
 *   - Mock all I/O boundaries (db.server, shopify.server, theme-fetcher.server,
 *     scan.server model, inngest client) so only orchestration logic is tested.
 *   - Call the function handler directly via `pollThemeChanges.fn({ event, step, logger })`
 *     to bypass the Inngest SDK runtime.
 *   - The step mock from createMockInngestStep() executes each callback immediately.
 *   - Key invariant (S-02 fix): the DB query uses PLANS.PROFESSIONAL ("Professional")
 *     NOT "professional" (lowercase). Test the actual plan filter string explicitly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockInngestStep } from "../mocks/inngest";
import { ScanStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/db.server", () => ({
  default: {
    shop: {
      findMany: vi.fn(),
    },
    scan: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("../../app/shopify.server", () => ({
  unauthenticated: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/services/theme-fetcher.server", () => ({
  fetchMainTheme: vi.fn(),
}));

vi.mock("../../app/models/scan.server", () => ({
  createScan: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    // createFunction is called at module load time by poll-theme-changes.ts.
    // We return a real-looking function object with a `.fn` accessor so that
    // pollThemeChanges.fn({ event, step, logger }) still works in tests.
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: any[]) => any) => ({
        fn: handler,
      }),
    ),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { pollThemeChanges } from "../../inngest/functions/poll-theme-changes";
import db from "../../app/db.server";
import { unauthenticated } from "../../app/shopify.server";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { createScan } from "../../app/models/scan.server";
import { inngest } from "../../inngest/client";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockDb = db as {
  shop: { findMany: ReturnType<typeof vi.fn> };
  scan: { findFirst: ReturnType<typeof vi.fn> };
};
const mockUnauthenticated = unauthenticated as { admin: ReturnType<typeof vi.fn> };
const mockFetchMainTheme = fetchMainTheme as ReturnType<typeof vi.fn>;
const mockCreateScan = createScan as ReturnType<typeof vi.fn>;
const mockInngestSend = (inngest as any).send as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-pro-001";
const SHOP_DOMAIN = "pro-shop.myshopify.com";

const THEME_GID = "gid://shopify/Theme/999888777";
const THEME_NAME = "Impulse";
const SCAN_ID = "scan-poll-abc";

const MOCK_ADMIN = { graphql: vi.fn() };

// S-14: accessToken removed from select — shop objects no longer carry it.
const MOCK_PROFESSIONAL_SHOP = {
  id: SHOP_ID,
  domain: SHOP_DOMAIN,
};

const MOCK_MAIN_THEME = {
  id: THEME_GID,
  name: THEME_NAME,
  updatedAt: new Date("2026-03-10T08:00:00Z"),
};

const MOCK_SCAN = {
  id: SCAN_ID,
  shopId: SHOP_ID,
  themeId: THEME_GID,
  themeName: THEME_NAME,
  status: "PENDING",
};

// ---------------------------------------------------------------------------
// Mock logger (Inngest logger interface)
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ---------------------------------------------------------------------------
// Helper: invoke function handler
// ---------------------------------------------------------------------------

async function runPollThemeChanges(
  stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
) {
  const step = { ...createMockInngestStep(), ...stepOverrides };
  const event = { name: "scheduled/daily", data: {}, ts: Date.now(), id: "test-event-poll" };
  return pollThemeChanges.fn({ event, step, logger: mockLogger } as any);
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path wiring
  mockDb.shop.findMany.mockResolvedValue([MOCK_PROFESSIONAL_SHOP]);
  mockUnauthenticated.admin.mockResolvedValue({ admin: MOCK_ADMIN });
  mockFetchMainTheme.mockResolvedValue(MOCK_MAIN_THEME);
  mockDb.scan.findFirst
    .mockResolvedValueOnce(null) // no in-progress scan
    .mockResolvedValueOnce(null); // no latest scan (so needsScan = true)
  mockCreateScan.mockResolvedValue(MOCK_SCAN);
  mockInngestSend.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Plan filter invariant — S-02 regression test
// ---------------------------------------------------------------------------

describe("pollThemeChanges — plan filter (S-02 regression)", () => {
  it("queries DB with plan: 'Professional' (capital P), not 'professional' (lowercase)", async () => {
    await runPollThemeChanges();

    expect(mockDb.shop.findMany).toHaveBeenCalledOnce();
    const callArg = mockDb.shop.findMany.mock.calls[0][0];

    // The fix: must use PLANS.PROFESSIONAL = "Professional", NOT "professional"
    expect(callArg.where.plan).toBe("Professional");
    expect(callArg.where.plan).not.toBe("professional");
  });

  it("includes the correct select fields when querying shops", async () => {
    await runPollThemeChanges();

    const callArg = mockDb.shop.findMany.mock.calls[0][0];
    // S-14: accessToken was removed from the select — unauthenticated.admin()
    // handles session lookup internally and fails naturally if no session exists.
    expect(callArg.select).toEqual({
      id: true,
      domain: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path — Professional shop with stale theme
// ---------------------------------------------------------------------------

describe("pollThemeChanges — happy path", () => {
  it("returns total count and results with dispatch_triggered outcome", async () => {
    const result = await runPollThemeChanges();

    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].domain).toBe(SHOP_DOMAIN);
    expect(result.results[0].outcome).toBe("dispatch_triggered");
    expect(result.summary.dispatch_triggered).toBe(1);
  });

  it("creates a scan record for the updated theme", async () => {
    await runPollThemeChanges();

    expect(mockCreateScan).toHaveBeenCalledWith(SHOP_ID, THEME_GID, THEME_NAME);
  });

  it("dispatches a scan/requested event after creating the scan", async () => {
    await runPollThemeChanges();

    expect(mockInngestSend).toHaveBeenCalledOnce();
    const event = mockInngestSend.mock.calls[0][0];

    expect(event.name).toBe("scan/requested");
    expect(event.data.shopId).toBe(SHOP_ID);
    expect(event.data.themeId).toBe(THEME_GID);
    expect(event.data.scanId).toBe(SCAN_ID);
  });

  it("fetches the main theme using unauthenticated admin for the shop domain", async () => {
    await runPollThemeChanges();

    expect(mockUnauthenticated.admin).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(mockFetchMainTheme).toHaveBeenCalledWith(MOCK_ADMIN);
  });

  it("triggers a scan when the theme was updated after the last scan", async () => {
    const lastScanDate = new Date("2026-03-09T00:00:00Z"); // yesterday
    // theme was updated at 2026-03-10T08:00:00Z which is AFTER lastScanDate

    // Reset and override the beforeEach wiring for this specific scenario
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst
      .mockResolvedValueOnce(null) // in-progress check: none
      .mockResolvedValueOnce({ createdAt: lastScanDate }); // last scan older than theme

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("dispatch_triggered");
    expect(mockCreateScan).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No shops — empty Professional cohort
// ---------------------------------------------------------------------------

describe("pollThemeChanges — no Professional shops", () => {
  beforeEach(() => {
    mockDb.shop.findMany.mockResolvedValue([]);
  });

  it("returns total of 0 with empty results array", async () => {
    const result = await runPollThemeChanges();

    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("does not call unauthenticated.admin when there are no shops", async () => {
    await runPollThemeChanges();

    expect(mockUnauthenticated.admin).not.toHaveBeenCalled();
  });

  it("does not call createScan when there are no shops", async () => {
    await runPollThemeChanges();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not send any Inngest events when there are no shops", async () => {
    await runPollThemeChanges();

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

// S-14: The skipped_no_token guard was removed. Shops without a valid session
// now reach unauthenticated.admin() which throws, producing an "error" outcome.
// The existing try/catch handles this gracefully — no separate guard needed.
describe("pollThemeChanges — shop with invalid/missing session (post S-14)", () => {
  it("returns error outcome when unauthenticated.admin throws for a shop without a session", async () => {
    mockUnauthenticated.admin.mockRejectedValueOnce(new Error("No session found for domain"));

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("error");
    expect(result.results[0].reason).toContain("No session found for domain");
    expect(result.results[0].domain).toBe(SHOP_DOMAIN);
  });

  it("does not call fetchMainTheme when unauthenticated.admin throws", async () => {
    mockUnauthenticated.admin.mockRejectedValueOnce(new Error("No session found for domain"));

    await runPollThemeChanges();

    expect(mockFetchMainTheme).not.toHaveBeenCalled();
  });

  it("does not create a scan when unauthenticated.admin throws", async () => {
    mockUnauthenticated.admin.mockRejectedValueOnce(new Error("No session found for domain"));

    await runPollThemeChanges();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });
});

describe("pollThemeChanges — skip: in-progress scan", () => {
  it("returns skipped_in_progress when an active scan already exists for this theme", async () => {
    const inProgressScanId = "scan-in-prog-999";
    // Reset and replace: in-progress scan IS found → should short-circuit
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: inProgressScanId });

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("skipped_in_progress");
    expect(result.results[0].reason).toContain(inProgressScanId);
  });

  it("does not create a new scan when one is already in progress", async () => {
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: "scan-in-prog-999" });

    await runPollThemeChanges();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not dispatch an event when a scan is in progress", async () => {
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: "scan-in-prog-999" });

    await runPollThemeChanges();

    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

describe("pollThemeChanges — skip: theme up to date", () => {
  it("returns skipped_up_to_date when theme updatedAt is older than last scan createdAt", async () => {
    // Last scan was AFTER the theme was updated → no re-scan needed
    const lastScanDate = new Date("2026-03-11T00:00:00Z"); // newer than theme updatedAt
    // theme updatedAt = 2026-03-10T08:00:00Z (from MOCK_MAIN_THEME)

    // Reset and replace with the exact two-call sequence for this scenario
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst
      .mockResolvedValueOnce(null) // in-progress check: none found
      .mockResolvedValueOnce({ createdAt: lastScanDate }); // latest scan: newer than theme

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("skipped_up_to_date");
  });

  it("does not create a scan when theme is up to date", async () => {
    const lastScanDate = new Date("2026-03-11T00:00:00Z");

    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ createdAt: lastScanDate });

    await runPollThemeChanges();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not dispatch an event when theme is up to date", async () => {
    const lastScanDate = new Date("2026-03-11T00:00:00Z");

    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ createdAt: lastScanDate });

    await runPollThemeChanges();

    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("triggers a scan when there is no previous scan at all (latestScan === null)", async () => {
    // This matches the beforeEach happy-path wiring, but be explicit for clarity
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst
      .mockResolvedValueOnce(null) // in-progress check: none found
      .mockResolvedValueOnce(null); // latest scan: none → needsScan = true

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("dispatch_triggered");
    expect(mockCreateScan).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Multi-shop processing
// ---------------------------------------------------------------------------

describe("pollThemeChanges — multiple shops", () => {
  it("processes each shop independently and returns correct summary", async () => {
    // S-14: shops no longer carry accessToken — session validity is checked
    // lazily by unauthenticated.admin(). shop2 here errors (no session).
    const shop1 = { id: "shop-1", domain: "shop1.myshopify.com" };
    const shop2 = { id: "shop-2", domain: "shop2.myshopify.com" }; // will error (no session)
    const shop3 = { id: "shop-3", domain: "shop3.myshopify.com" };

    mockDb.shop.findMany.mockResolvedValue([shop1, shop2, shop3]);

    // shop1: will be dispatched (theme stale)
    // shop2: error outcome — unauthenticated.admin throws (no session)
    // shop3: in-progress scan exists

    mockUnauthenticated.admin
      .mockResolvedValueOnce({ admin: MOCK_ADMIN }) // for shop1
      .mockRejectedValueOnce(new Error("No session for shop2")) // for shop2
      .mockResolvedValueOnce({ admin: MOCK_ADMIN }); // for shop3

    mockFetchMainTheme
      .mockResolvedValueOnce(MOCK_MAIN_THEME) // for shop1
      .mockResolvedValueOnce(MOCK_MAIN_THEME); // for shop3

    // Reset scan.findFirst from beforeEach and set the full 3-call sequence
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst
      .mockResolvedValueOnce(null) // shop1: in-progress check → none
      .mockResolvedValueOnce(null) // shop1: latest scan check → none → dispatch
      .mockResolvedValueOnce({ id: "scan-inprog" }); // shop3: in-progress check → found

    mockCreateScan.mockResolvedValue(MOCK_SCAN);

    const result = await runPollThemeChanges();

    expect(result.total).toBe(3);
    expect(result.summary.dispatch_triggered).toBe(1);
    expect(result.summary.error).toBe(1);
    expect(result.summary.skipped_in_progress).toBe(1);

    const shop1Result = result.results.find(
      (r: { domain: string }) => r.domain === "shop1.myshopify.com",
    );
    const shop2Result = result.results.find(
      (r: { domain: string }) => r.domain === "shop2.myshopify.com",
    );
    const shop3Result = result.results.find(
      (r: { domain: string }) => r.domain === "shop3.myshopify.com",
    );

    expect(shop1Result?.outcome).toBe("dispatch_triggered");
    expect(shop2Result?.outcome).toBe("error");
    expect(shop3Result?.outcome).toBe("skipped_in_progress");
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("pollThemeChanges — error paths", () => {
  it("records error outcome when fetchMainTheme throws (Shopify API error)", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(new Error("Token expired"));

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("error");
    expect(result.results[0].reason).toContain("Token expired");
  });

  it("records error outcome when unauthenticated.admin throws", async () => {
    mockUnauthenticated.admin.mockRejectedValueOnce(new Error("Invalid domain"));

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("error");
    expect(result.results[0].reason).toContain("Invalid domain");
  });

  it("records error outcome when fetchMainTheme returns null (no main theme)", async () => {
    mockFetchMainTheme.mockResolvedValueOnce(null);

    const result = await runPollThemeChanges();

    expect(result.results[0].outcome).toBe("error");
    expect(result.results[0].reason).toContain("no main theme found");
  });

  it("does not create a scan on error path", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(new Error("API failure"));

    await runPollThemeChanges();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not dispatch an event on error path", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(new Error("API failure"));

    await runPollThemeChanges();

    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("continues processing remaining shops when one shop errors", async () => {
    // S-14: shops no longer carry accessToken in select
    const shop1 = { id: "shop-1", domain: "shop1.myshopify.com" };
    const shop2 = { id: "shop-2", domain: "shop2.myshopify.com" };

    mockDb.shop.findMany.mockResolvedValue([shop1, shop2]);

    // shop1 errors; shop2 succeeds
    mockUnauthenticated.admin
      .mockResolvedValueOnce({ admin: MOCK_ADMIN }) // shop1
      .mockResolvedValueOnce({ admin: MOCK_ADMIN }); // shop2

    mockFetchMainTheme
      .mockRejectedValueOnce(new Error("shop1 failure")) // shop1 errors
      .mockResolvedValueOnce(MOCK_MAIN_THEME); // shop2 succeeds

    mockDb.scan.findFirst
      .mockResolvedValueOnce(null) // shop2: no in-progress
      .mockResolvedValueOnce(null); // shop2: no latest scan

    mockCreateScan.mockResolvedValue({ ...MOCK_SCAN, shopId: "shop-2" });

    const result = await runPollThemeChanges();

    expect(result.total).toBe(2);

    const shop1Result = result.results.find(
      (r: { domain: string }) => r.domain === "shop1.myshopify.com",
    );
    const shop2Result = result.results.find(
      (r: { domain: string }) => r.domain === "shop2.myshopify.com",
    );

    expect(shop1Result?.outcome).toBe("error");
    expect(shop2Result?.outcome).toBe("dispatch_triggered");
    // shop2 still got its scan created
    expect(mockCreateScan).toHaveBeenCalledOnce();
  });
});
