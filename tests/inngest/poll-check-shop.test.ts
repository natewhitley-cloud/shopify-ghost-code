/**
 * Tests for the poll-check-shop Inngest worker function.
 *
 * This function is triggered by `poll/check-shop` events (emitted by the
 * poll-theme-changes coordinator). It handles per-shop theme-change detection:
 *   1. Fetch the shop's main theme from Shopify (updatedAt).
 *   2. Check for an active (PENDING or IN_PROGRESS) scan → skip if found.
 *   3. Compare theme updatedAt against the latest SUCCESSFUL scan's createdAt
 *      (FAILED scans ignored — LOG-7).
 *   4. If stale (or no prior successful scan), create a scan record in a
 *      `create-scan` step, then dispatch `scan/requested` via step.sendEvent in
 *      a separate step so each is idempotent on retry (LOG-8).
 *
 * Strategy:
 *   - Mock all I/O boundaries (db.server, shopify.server, theme-fetcher.server,
 *     scan.server model, inngest client) so only per-shop logic is tested.
 *   - Call the function handler directly via `pollCheckShop.fn({ event, step, logger })`.
 *   - The step mock from createMockInngestStep() executes each callback immediately.
 */

import { ScanStatus } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../../app/db.server", () => ({
  default: {
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
  getLatestSuccessfulScanForTheme: vi.fn(),
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    // createFunction is called at module load time by poll-check-shop.ts.
    // We return a real-looking function object with a `.fn` accessor so that
    // pollCheckShop.fn({ event, step, logger }) still works in tests.
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { createScan, getLatestSuccessfulScanForTheme } from "../../app/models/scan.server";
import { fetchMainTheme } from "../../app/services/theme-fetcher.server";
import { unauthenticated } from "../../app/shopify.server";
import { inngest } from "../../inngest/client";
import { pollCheckShop } from "../../inngest/functions/poll-check-shop";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockDb = db as unknown as {
  scan: { findFirst: ReturnType<typeof vi.fn> };
};
const mockUnauthenticated = unauthenticated as unknown as { admin: ReturnType<typeof vi.fn> };
const mockFetchMainTheme = fetchMainTheme as ReturnType<typeof vi.fn>;
const mockCreateScan = createScan as ReturnType<typeof vi.fn>;
const mockGetLatestSuccessfulScan = getLatestSuccessfulScanForTheme as ReturnType<typeof vi.fn>;
// inngest.send is no longer used by the function (dispatch goes through
// step.sendEvent now — LOG-8). Kept here only to assert it is NOT called.
const mockInngestSend = (inngest as unknown as { send: ReturnType<typeof vi.fn> }).send;

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const SHOP_ID = "shop-pro-001";
const SHOP_DOMAIN = "pro-shop.myshopify.com";

const THEME_GID = "gid://shopify/Theme/999888777";
const THEME_NAME = "Impulse";
const SCAN_ID = "scan-poll-abc";

const MOCK_ADMIN = { graphql: vi.fn() };

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

// Holds the step mock from the most recent runPollCheckShop call so tests can
// assert on step.sendEvent (the function dispatches via step.sendEvent, not
// inngest.send — LOG-8). Reassigned on every run.
let lastStep: ReturnType<typeof createMockInngestStep>;

async function runPollCheckShop(
  shopId = SHOP_ID,
  shopDomain = SHOP_DOMAIN,
  stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
) {
  const step = { ...createMockInngestStep(), ...stepOverrides };
  lastStep = step;
  const event = {
    name: "poll/check-shop",
    data: { shopId, shopDomain },
    ts: Date.now(),
    id: "test-event-check-shop",
  };
  return getInngestHandler(pollCheckShop)({ event, step, logger: mockLogger });
}

// ---------------------------------------------------------------------------
// Setup: reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path wiring: stale theme → dispatch scan.
  // Step 2 (active-scan check) uses db.scan.findFirst; Step 3 (staleness) uses
  // the getLatestSuccessfulScanForTheme model helper.
  mockUnauthenticated.admin.mockResolvedValue({ admin: MOCK_ADMIN });
  mockFetchMainTheme.mockResolvedValue(MOCK_MAIN_THEME);
  mockDb.scan.findFirst.mockResolvedValue(null); // no in-progress scan
  mockGetLatestSuccessfulScan.mockResolvedValue(null); // no successful scan → needsScan = true
  mockCreateScan.mockResolvedValue(MOCK_SCAN);
  mockInngestSend.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Happy path — stale theme triggers dispatch
// ---------------------------------------------------------------------------

describe("pollCheckShop — happy path", () => {
  it("returns dispatch_triggered outcome when theme is stale", async () => {
    const result = await runPollCheckShop();

    expect(result.outcome).toBe("dispatch_triggered");
    expect(result.domain).toBe(SHOP_DOMAIN);
    expect(result.scanId).toBe(SCAN_ID);
  });

  it("fetches the main theme using unauthenticated admin for the shop domain", async () => {
    await runPollCheckShop();

    expect(mockUnauthenticated.admin).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(mockFetchMainTheme).toHaveBeenCalledWith(MOCK_ADMIN);
  });

  it("creates a scan record with the correct shop and theme identifiers", async () => {
    await runPollCheckShop();

    expect(mockCreateScan).toHaveBeenCalledWith(SHOP_ID, THEME_GID, THEME_NAME);
  });

  it("dispatches a scan/requested event via step.sendEvent after creating the scan", async () => {
    await runPollCheckShop();

    // LOG-8: dispatch goes through the idempotent step.sendEvent primitive,
    // not inngest.send inside a step.run.
    expect(mockInngestSend).not.toHaveBeenCalled();
    expect(lastStep.sendEvent).toHaveBeenCalledOnce();

    const [stepId, sentEvent] = lastStep.sendEvent.mock.calls[0];
    expect(stepId).toBe("send-scan-requested");
    expect(sentEvent.name).toBe("scan/requested");
    expect(sentEvent.data.shopId).toBe(SHOP_ID);
    expect(sentEvent.data.themeId).toBe(THEME_GID);
    expect(sentEvent.data.scanId).toBe(SCAN_ID);
  });

  it("triggers a scan when the theme was updated after the last successful scan", async () => {
    const lastScanDate = new Date("2026-03-09T00:00:00Z"); // yesterday
    // theme was updated at 2026-03-10T08:00:00Z which is AFTER lastScanDate
    mockGetLatestSuccessfulScan.mockResolvedValue({ createdAt: lastScanDate });

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("dispatch_triggered");
    expect(mockCreateScan).toHaveBeenCalled();
  });

  it("triggers a scan when there is no previous successful scan at all", async () => {
    mockGetLatestSuccessfulScan.mockResolvedValue(null);

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("dispatch_triggered");
    expect(mockCreateScan).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Skip: in-progress scan
// ---------------------------------------------------------------------------

describe("pollCheckShop — skip: in-progress scan", () => {
  it("returns skipped_in_progress when an active scan exists for this theme", async () => {
    const inProgressScanId = "scan-in-prog-999";

    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: inProgressScanId });

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("skipped_in_progress");
    expect(result.reason).toContain(inProgressScanId);
    expect(result.domain).toBe(SHOP_DOMAIN);
  });

  it("does not create a new scan when one is already in progress", async () => {
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: "scan-in-prog-999" });

    await runPollCheckShop();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not dispatch an event when a scan is in progress", async () => {
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: "scan-in-prog-999" });

    await runPollCheckShop();

    expect(lastStep.sendEvent).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  // S-08: PENDING scan should suppress dispatch (prevents orphan PENDING scans
  // when Inngest is temporarily down between cron runs).
  it("returns skipped_in_progress when a PENDING scan already exists for this theme", async () => {
    const pendingScanId = "scan-pending-456";

    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: pendingScanId });

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("skipped_in_progress");
    expect(result.reason).toContain(pendingScanId);
  });

  it("does not create a new scan when a PENDING scan already exists", async () => {
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst.mockResolvedValueOnce({ id: "scan-pending-456" });

    await runPollCheckShop();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("queries for both PENDING and IN_PROGRESS statuses in the active-scan check", async () => {
    mockDb.scan.findFirst.mockReset();
    mockDb.scan.findFirst
      .mockResolvedValueOnce(null) // active scan check: none
      .mockResolvedValueOnce(null); // latest scan check: none

    await runPollCheckShop();

    const activeCheckCallArg = mockDb.scan.findFirst.mock.calls[0][0];
    expect(activeCheckCallArg.where.status.in).toContain(ScanStatus.PENDING);
    expect(activeCheckCallArg.where.status.in).toContain(ScanStatus.IN_PROGRESS);
  });
});

// ---------------------------------------------------------------------------
// Skip: theme up to date
// ---------------------------------------------------------------------------

describe("pollCheckShop — skip: theme up to date", () => {
  // theme updatedAt = 2026-03-10T08:00:00Z (from MOCK_MAIN_THEME)
  const COMPLETED_AFTER_THEME = new Date("2026-03-11T00:00:00Z"); // newer than theme

  it("returns skipped_up_to_date when theme updatedAt is older than the latest successful scan", async () => {
    mockGetLatestSuccessfulScan.mockResolvedValue({ createdAt: COMPLETED_AFTER_THEME });

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("skipped_up_to_date");
    expect(result.domain).toBe(SHOP_DOMAIN);
  });

  // LOG-7: a PARTIAL scan is a legitimate successful result, so a recent
  // PARTIAL scan newer than the theme update also suppresses a re-scan.
  it("returns skipped_up_to_date when a PARTIAL scan newer than the theme update exists", async () => {
    mockGetLatestSuccessfulScan.mockResolvedValue({ createdAt: COMPLETED_AFTER_THEME });

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("skipped_up_to_date");
    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not create a scan when theme is up to date", async () => {
    mockGetLatestSuccessfulScan.mockResolvedValue({ createdAt: COMPLETED_AFTER_THEME });

    await runPollCheckShop();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not dispatch an event when theme is up to date", async () => {
    mockGetLatestSuccessfulScan.mockResolvedValue({ createdAt: COMPLETED_AFTER_THEME });

    await runPollCheckShop();

    expect(lastStep.sendEvent).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("pollCheckShop — error paths", () => {
  it("returns error outcome when unauthenticated.admin throws (no session)", async () => {
    mockUnauthenticated.admin.mockRejectedValueOnce(new Error("No session found for domain"));

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("No session found for domain");
    expect(result.domain).toBe(SHOP_DOMAIN);
  });

  it("does not call fetchMainTheme when unauthenticated.admin throws", async () => {
    mockUnauthenticated.admin.mockRejectedValueOnce(new Error("No session found for domain"));

    await runPollCheckShop();

    expect(mockFetchMainTheme).not.toHaveBeenCalled();
  });

  it("returns error outcome when fetchMainTheme throws (Shopify API error)", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(new Error("Token expired"));

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("Token expired");
  });

  it("returns error outcome when fetchMainTheme returns null (no main theme)", async () => {
    mockFetchMainTheme.mockResolvedValueOnce(null);

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("no main theme found");
  });

  it("does not create a scan on Shopify API error", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(new Error("API failure"));

    await runPollCheckShop();

    expect(mockCreateScan).not.toHaveBeenCalled();
  });

  it("does not dispatch a scan/requested event on Shopify API error", async () => {
    mockFetchMainTheme.mockRejectedValueOnce(new Error("API failure"));

    await runPollCheckShop();

    expect(lastStep.sendEvent).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("wraps non-Error throws in the error reason string", async () => {
    mockUnauthenticated.admin.mockRejectedValueOnce("string error");

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("string error");
  });
});

// ---------------------------------------------------------------------------
// LOG-7: a FAILED last scan must not permanently suppress re-scans
// ---------------------------------------------------------------------------

describe("pollCheckShop — LOG-7: failed scan does not suppress re-scan", () => {
  it("uses getLatestSuccessfulScanForTheme (status-filtered) for the staleness check", async () => {
    await runPollCheckShop();

    expect(mockGetLatestSuccessfulScan).toHaveBeenCalledWith(SHOP_ID, THEME_GID);
    // Only the active-scan check should hit db.scan.findFirst directly — the
    // staleness query goes through the model helper, never an unfiltered query.
    expect(mockDb.scan.findFirst).toHaveBeenCalledTimes(1);
  });

  it("re-scans when there is no successful scan (e.g. the latest scan FAILED)", async () => {
    // getLatestSuccessfulScanForTheme filters to COMPLETED/PARTIAL, so a shop
    // whose most recent scan FAILED has no successful baseline and the helper
    // returns null → a re-scan must be dispatched. Previously the unfiltered
    // query returned the FAILED scan's createdAt (always after the theme
    // update that triggered it) and suppressed re-scans indefinitely.
    mockGetLatestSuccessfulScan.mockResolvedValue(null);

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("dispatch_triggered");
    expect(mockCreateScan).toHaveBeenCalled();
    expect(lastStep.sendEvent).toHaveBeenCalledOnce();
  });

  it("re-scans when the theme was updated after the last successful scan", async () => {
    // theme updatedAt = 2026-03-10T08:00:00Z; last success predates it.
    mockGetLatestSuccessfulScan.mockResolvedValue({
      createdAt: new Date("2026-03-09T00:00:00Z"),
    });

    const result = await runPollCheckShop();

    expect(result.outcome).toBe("dispatch_triggered");
    expect(mockCreateScan).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LOG-8: dispatch is split into two idempotent steps (create-scan + sendEvent)
// ---------------------------------------------------------------------------

describe("pollCheckShop — LOG-8: idempotent dispatch on send failure", () => {
  it("creates the scan and dispatches via step.sendEvent (not inngest.send)", async () => {
    await runPollCheckShop();

    expect(lastStep.run).toHaveBeenCalledWith("create-scan", expect.any(Function));
    expect(mockCreateScan).toHaveBeenCalledOnce();
    expect(lastStep.sendEvent).toHaveBeenCalledWith(
      "send-scan-requested",
      expect.objectContaining({
        name: "scan/requested",
        data: expect.objectContaining({ scanId: SCAN_ID }),
      }),
    );
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("does not re-run createScan when the event-send step fails and retries", async () => {
    // Stateful step mock that memoizes step.run output by step id, mirroring
    // Inngest's real behavior: a step that already succeeded is not re-executed
    // when a LATER step is retried. step.sendEvent fails once, then succeeds.
    const memo = new Map<string, unknown>();
    const memoizingStep = {
      run: vi.fn(async (name: string, fn: () => unknown) => {
        if (memo.has(name)) return memo.get(name);
        const out = await fn();
        memo.set(name, out);
        return out;
      }),
      sendEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient Inngest send failure"))
        .mockResolvedValueOnce(undefined),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
      waitForEvent: vi.fn(),
      invoke: vi.fn(),
    };

    // createScan succeeds once; if it were ever called again (the old bug, where
    // create + send shared one step) it would throw the deterministic
    // "already in progress" error against the PENDING row it just created.
    mockCreateScan.mockReset();
    mockCreateScan
      .mockResolvedValueOnce(MOCK_SCAN)
      .mockRejectedValue(new Error("A scan is already in progress for this shop."));

    // First invocation: create-scan runs and is memoized, then the send step
    // throws → the invocation rejects (Inngest would retry it).
    await expect(runPollCheckShop(SHOP_ID, SHOP_DOMAIN, memoizingStep)).rejects.toThrow(
      "transient Inngest send failure",
    );

    // Retry: same step instance (memo + sendEvent state preserved). create-scan
    // is NOT re-run (its output is memoized), so createScan stays at one call,
    // no "already in progress" error occurs, and the send succeeds this time.
    const result = await runPollCheckShop(SHOP_ID, SHOP_DOMAIN, memoizingStep);

    expect(result.outcome).toBe("dispatch_triggered");
    expect(result.scanId).toBe(SCAN_ID);
    expect(mockCreateScan).toHaveBeenCalledTimes(1);
    expect(memoizingStep.sendEvent).toHaveBeenCalledTimes(2);
  });
});
