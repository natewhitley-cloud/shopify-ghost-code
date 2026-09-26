/**
 * Tests for app/services/prompt-cap.server.ts (gc-97k.6): loadShopPromptState
 * and resolvePrompt with the REAL claimPromptSlot / getShopMetadata (shop
 * model) against a mocked Prisma client, so the conditional-update claim and
 * the lost-claim re-read are exercised end to end.
 *
 * Owner decision 1A (strict GLOBAL priority): resolvePrompt computes the SHOP's
 * eligibility itself and renders only what the calling page can render. The
 * "10-day simulation" below replays the audit that found the old first-come
 * cap starved the scan page's prompts: Home is visited FIRST every day, then
 * the scan page, against one in-memory Shop row driven by the real services.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { updateMany: vi.fn(), findUnique: vi.fn() },
  scan: { findFirst: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

// Telemetry rows are not what these tests are about; the stamps they claim are.
vi.mock("../../app/services/nudge-telemetry.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/nudge-telemetry.server")>()),
  recordNudgeShown: vi.fn(),
  recordNudgeClicked: vi.fn(),
  recordNudgeDismissed: vi.fn(),
  recordNudgeNotShown: vi.fn(),
  recordNudgeConverted: vi.fn(),
}));

const mockLoggerError = vi.fn();
vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { HOME_PROMPTS, PROMPT_CAP_WINDOW_MS, scanResultsPrompts } from "../../app/lib/prompt-cap";
import type { PromptKey } from "../../app/lib/prompt-cap";
import type { ShopMetadata } from "../../app/models/shop.server";
import { recordNudgeStageOnce } from "../../app/services/nudge-stage.server";
import { NUDGE_KEYS } from "../../app/services/nudge-telemetry.server";
import { loadShopPromptState, resolvePrompt } from "../../app/services/prompt-cap.server";
import type { ShopPromptContext } from "../../app/services/prompt-cap.server";
import { recordReviewRequestResult } from "../../app/services/review-request.server";
import { markUpgradeReturnShown } from "../../app/services/upgrade-return.server";

const DOMAIN = "merchant.myshopify.com";
const NOW = new Date("2026-09-26T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const FRESH = { lastPromptKey: null, lastPromptShownAt: null };

/** Every page that can render everything, so only eligibility and the cap decide. */
const ALL: PromptKey[] = ["review_popup", "upgrade_return", "feedback"];

/**
 * Prompt state eligible for exactly `keys` (a paid, brand-new shop is eligible
 * for nothing; each key switches on the facts its own rule needs).
 */
function stateFor(
  keys: PromptKey[],
  cap: { lastPromptKey: string | null; lastPromptShownAt: Date | null } = FRESH,
): ShopPromptContext {
  return {
    plan: keys.includes("upgrade_return") ? "free" : "Standard",
    installedAt: keys.includes("feedback") ? ago(10 * DAY) : NOW,
    firstSuccessfulScanAt:
      keys.includes("upgrade_return") || keys.includes("feedback") ? ago(2 * DAY) : null,
    firstResultsViewedAt: keys.includes("review_popup") ? ago(3 * HOUR) : null,
    reviewPopupRequestedAt: null,
    upgradeReturnLastShownAt: null,
    upgradeReturnLastDismissedAt: null,
    upgradeReturnDismissCount: 0,
    feedbackNudgeDismissedAt: null,
    feedbackSubmittedAt: null,
    ...cap,
  };
}

function input(
  keys: PromptKey[],
  cap: { lastPromptKey: string | null; lastPromptShownAt: Date | null } = FRESH,
  renderable: readonly PromptKey[] = ALL,
) {
  return { shopDomain: DOMAIN, state: stateFor(keys, cap), renderable, now: NOW };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("loadShopPromptState", () => {
  const SHOP = {
    id: "shop-1",
    domain: DOMAIN,
    ...stateFor([]),
  } as unknown as ShopMetadata;

  it("reads the first successful scan when a rule can use it (Free shop)", async () => {
    const first = ago(3 * DAY);
    mockDb.scan.findFirst.mockResolvedValue({ completedAt: first });

    const state = await loadShopPromptState({ ...SHOP, plan: "free" }, NOW);

    expect(mockDb.scan.findFirst).toHaveBeenCalledTimes(1);
    expect(state.firstSuccessfulScanAt).toEqual(first);
    expect(state.plan).toBe("free");
  });

  it("skips the read (null) when no rule can use it (young paid shop)", async () => {
    const state = await loadShopPromptState(SHOP, NOW);

    expect(mockDb.scan.findFirst).not.toHaveBeenCalled();
    expect(state.firstSuccessfulScanAt).toBeNull();
  });
});

describe("resolvePrompt", () => {
  it("nothing eligible: null and no write", async () => {
    await expect(resolvePrompt(input([]))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("cap blocks a different prompt: null and no write", async () => {
    const cap = { lastPromptKey: "feedback", lastPromptShownAt: ago(HOUR) };
    await expect(resolvePrompt(input(["upgrade_return"], cap))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("same prompt inside its window: renders with no write (window not extended)", async () => {
    const cap = { lastPromptKey: "feedback", lastPromptShownAt: ago(HOUR) };
    await expect(resolvePrompt(input(["feedback"], cap))).resolves.toBe("feedback");
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("a higher prompt pending that this page cannot render: null and NO claim", async () => {
    await expect(
      resolvePrompt(input(["upgrade_return", "feedback"], FRESH, HOME_PROMPTS)),
    ).resolves.toBeNull();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("a new pick claims the slot keyed on the previous state it read", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(resolvePrompt(input(["feedback"], FRESH, HOME_PROMPTS))).resolves.toBe("feedback");

    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: DOMAIN, lastPromptKey: null, lastPromptShownAt: null },
      data: { lastPromptKey: "feedback", lastPromptShownAt: NOW },
    });
    expect(mockDb.shop.findUnique).not.toHaveBeenCalled();
  });

  it("an expired window re-claims (same key) keyed on the old timestamp", async () => {
    const old = ago(PROMPT_CAP_WINDOW_MS);
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      resolvePrompt(input(["feedback"], { lastPromptKey: "feedback", lastPromptShownAt: old })),
    ).resolves.toBe("feedback");

    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: DOMAIN, lastPromptKey: "feedback", lastPromptShownAt: old },
      data: { lastPromptKey: "feedback", lastPromptShownAt: NOW },
    });
  });

  it("lost claim, winner took the SAME prompt: renders it without a second write", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce({
      ...stateFor(["feedback"]),
      lastPromptKey: "feedback",
      lastPromptShownAt: NOW,
    });

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBe("feedback");
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lost claim, winner took a DIFFERENT prompt: renders nothing", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce({
      ...stateFor(["feedback"]),
      lastPromptKey: "upgrade_return",
      lastPromptShownAt: NOW,
    });

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lost claim and the re-read state still needs a claim: renders nothing (no retry loop)", async () => {
    // e.g. the row changed back to an expired state between the claim and the re-read.
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce({
      ...stateFor(["feedback"]),
      lastPromptKey: "feedback",
      lastPromptShownAt: ago(2 * PROMPT_CAP_WINDOW_MS),
    });

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lost claim and the re-read shows the prompt no longer eligible: renders nothing", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce({
      ...stateFor(["feedback"]),
      feedbackNudgeDismissedAt: NOW,
      lastPromptKey: "feedback",
      lastPromptShownAt: NOW,
    });

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
  });

  it("lost claim because the shop row is gone: null", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce(null);

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
  });

  it("never throws: a failed claim logs and fails closed (null)", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockLoggerError).toHaveBeenCalledWith("prompt-cap-claim-failed", {
      shop: DOMAIN,
      prompt: "feedback",
      error: "db down",
    });
  });

  it("never throws: a failed re-read after a lost claim logs and fails closed", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockRejectedValueOnce(new Error("read failed"));

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A stateful in-memory Shop row
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** True when `current` satisfies one Prisma where-value (equality or filter). */
function matchesValue(current: unknown, cond: unknown): boolean {
  if (cond instanceof Date) return current instanceof Date && current.getTime() === cond.getTime();
  if (cond !== null && typeof cond === "object") {
    const c = cond as Record<string, unknown>;
    const t = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
    if ("not" in c && matchesValue(current, c.not)) return false;
    if ("equals" in c && !matchesValue(current, c.equals)) return false;
    if (current === null || current === undefined) {
      return !("gt" in c || "gte" in c || "lt" in c || "lte" in c);
    }
    if ("gt" in c && !(t(current) > t(c.gt))) return false;
    if ("gte" in c && !(t(current) >= t(c.gte))) return false;
    if ("lt" in c && !(t(current) < t(c.lt))) return false;
    if ("lte" in c && !(t(current) <= t(c.lte))) return false;
    return true;
  }
  return current === cond;
}

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => matchesWhere(row, w));
    if (k === "AND") return (v as Row[]).every((w) => matchesWhere(row, w));
    return matchesValue(row[k], v);
  });
}

/**
 * Install one in-memory Shop row. updateMany applies its data only when every
 * where clause still matches (Postgres row-level compare-and-set), supports
 * `{ increment }`, and yields first so concurrent calls interleave.
 */
function installRow(initial: Row): Row {
  const row: Row = { ...initial };
  mockDb.shop.updateMany.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
    await Promise.resolve();
    if (!matchesWhere(row, where)) return { count: 0 };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v === "object" && "increment" in (v as Row)) {
        row[k] = (row[k] as number) + ((v as Row).increment as number);
      } else {
        row[k] = v;
      }
    }
    return { count: 1 };
  });
  mockDb.shop.findUnique.mockImplementation(async () => ({ ...row }));
  return row;
}

describe("resolvePrompt: concurrency", () => {
  it("a Home load and a scan load racing on a fresh window: at most one prompt claims", async () => {
    // The scan page (popup) and Home (feedback) both read the same fresh state.
    // Under strict priority only the popup is pending, so Home renders nothing.
    const row = installRow({ domain: DOMAIN, ...stateFor(["review_popup", "feedback"]) });
    const state = stateFor(["review_popup", "feedback"]);

    const [scan, home] = await Promise.all([
      resolvePrompt({ shopDomain: DOMAIN, state, renderable: ["review_popup"], now: NOW }),
      resolvePrompt({ shopDomain: DOMAIN, state, renderable: HOME_PROMPTS, now: NOW }),
    ]);

    expect(home).toBeNull();
    expect(scan).toBe("review_popup");
    expect(row.lastPromptKey).toBe("review_popup");
  });

  it("two loads claiming the SAME prompt both render it, with one write winning", async () => {
    const row = installRow({ domain: DOMAIN, ...stateFor(["feedback"]) });

    const [a, b] = await Promise.all([
      resolvePrompt(input(["feedback"])),
      resolvePrompt(input(["feedback"])),
    ]);

    expect([a, b]).toEqual(["feedback", "feedback"]);
    expect(row.lastPromptKey).toBe("feedback");
  });
});

// ---------------------------------------------------------------------------
// The auditor's 10-day simulation, as a test
// ---------------------------------------------------------------------------

describe("10-day simulation: Home visited first each day, then the scan page", () => {
  const DAY0 = new Date("2026-09-01T10:00:00Z");
  const at = (day: number, hh: number, mm: number) =>
    new Date(DAY0.getTime() + day * DAY + (hh - 10) * HOUR + mm * 60 * 1000);

  /** A Free shop: installed, scanned and first viewed its results on day 0. */
  function freshFreeShop(): Row {
    return installRow({
      id: "shop-1",
      domain: DOMAIN,
      plan: "free",
      installedAt: DAY0,
      firstResultsViewedAt: at(0, 10, 5),
      reviewPopupRequestedAt: null,
      upgradeReturnLastShownAt: null,
      upgradeReturnLastDismissedAt: null,
      upgradeReturnDismissCount: 0,
      upgradeReturnShownAt: null,
      feedbackNudgeShownAt: null,
      feedbackNudgeDismissedAt: null,
      feedbackSubmittedAt: null,
      lastPromptKey: null,
      lastPromptShownAt: null,
    });
  }

  /** One page view through the real services, as the loaders do it. */
  async function visit(row: Row, renderable: readonly PromptKey[], now: Date) {
    const shop = { ...row } as unknown as ShopMetadata;
    const state = await loadShopPromptState(shop, now);
    const prompt = await resolvePrompt({ shopDomain: DOMAIN, state, renderable, now });
    // What the rendered prompt leads to, as the page and its client do it.
    if (prompt === "review_popup") await recordReviewRequestResult(DOMAIN, "success");
    if (prompt === "upgrade_return") {
      await markUpgradeReturnShown(DOMAIN, { ...row } as never, now);
    }
    if (prompt === "feedback") await recordNudgeStageOnce(NUDGE_KEYS.FEEDBACK, "shown", DOMAIN);
    return prompt;
  }

  const SCAN_PAGE = scanResultsPrompts({
    scanSuccessful: true,
    plan: "free",
    hasHiddenFindings: true,
  });

  async function simulate(days: number) {
    const row = freshFreeShop();
    mockDb.scan.findFirst.mockResolvedValue({ completedAt: DAY0 });
    const log: Array<[day: number, home: PromptKey | null, scan: PromptKey | null]> = [];
    for (let d = 1; d <= days; d++) {
      vi.setSystemTime(at(d, 12, 0));
      const home = await visit(row, HOME_PROMPTS, at(d, 12, 0));
      vi.setSystemTime(at(d, 12, 1));
      const scan = await visit(row, SCAN_PAGE, at(d, 12, 1));
      log.push([d, home, scan]);
    }
    return log;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows each prompt where it can render, in priority order, and Home never steals the slot", async () => {
    const log = await simulate(10);

    expect(log).toEqual([
      // The popup is pending from day 1: Home shows nothing, the scan page shows it.
      [1, null, "review_popup"],
      // The return banner is next (first scan 24h+ ago). Home still shows nothing.
      [2, null, "upgrade_return"],
      // Episode over at 24h, weekly re-show not due, feedback not yet 7 days old.
      [3, null, null],
      [4, null, null],
      [5, null, null],
      [6, null, null],
      // Feedback is eligible (installed 7d+) and nothing higher is pending.
      [7, "feedback", null],
      [8, "feedback", null],
      // Home claims feedback at 12:00; the return banner becomes due at 12:01
      // (7 days after its last episode) but the window holds until day 10.
      [9, "feedback", null],
      // The banner is pending again, so Home shows nothing and the scan page shows it.
      [10, null, "upgrade_return"],
    ]);
  });

  it("the scan-page prompt shows on day 1 and Home shows nothing while it is pending", async () => {
    const [[, home, scan]] = await simulate(1);

    expect(scan).toBe("review_popup");
    expect(home).toBeNull();
  });
});
