/**
 * Tests for app/services/summary-email.server.ts (gc-ol95): the merchant
 * summary email. fetch is ALWAYS mocked: no test may reach the real Resend
 * API, and the ledger/token/email-cache models are mocked (no database).
 */
import { FindingType } from "@prisma/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  record: vi.fn(),
  ensureToken: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../app/models/merchant-alert.server", () => ({
  recordMerchantAlert: m.record,
  ensureUnsubscribeToken: m.ensureToken,
}));
vi.mock("../../app/services/shop-alert-email.server", () => ({
  refreshShopContact: m.refresh,
}));
// finding-aggregation imports the db client; the pure filter needs none.
vi.mock("../../app/db.server", () => ({ default: {} }));

import { logger } from "../../app/lib/logger.server";
import type { SummaryRemovalRow } from "../../app/models/app-removal.server";
import {
  ALPENGLOW_LOGO_URL,
  MAX_APPS_IN_EMAIL,
  MAX_STORE_NAME_IN_EMAIL,
  buildSummaryHash,
  buildSummaryHtml,
  buildSummarySubject,
  buildSummaryText,
  computeFindingChanges,
  hasSummaryChanges,
  sendScanSummary,
  storeNameForEmail,
  summarizeAppRemovals,
  summaryRateSkipReason,
  summaryShopSkipReason,
} from "../../app/services/summary-email.server";
import type {
  SummaryApp,
  SummaryChanges,
  SummaryShop,
} from "../../app/services/summary-email.server";

const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();
const DAY = 24 * 60 * 60 * 1000;
const SHOP_DOMAIN = "my-store.myshopify.com";

const NO_CHANGES: SummaryChanges = {
  newCount: 0,
  fixedCount: 0,
  openCount: 7,
  inactiveApps: [],
  cleanedApps: [],
};
const changes = (over: Partial<SummaryChanges> = {}): SummaryChanges => ({
  ...NO_CHANGES,
  newCount: 2,
  fixedCount: 1,
  ...over,
});
const app = (appName: string, leftoverCount = 3): SummaryApp => ({ appName, leftoverCount });

/** A shop that is fully eligible (notice shown) unless overridden. */
const shop = (over: Partial<SummaryShop> = {}): SummaryShop => ({
  id: "shop-1",
  domain: SHOP_DOMAIN,
  plan: "Professional",
  alertsEnabled: true,
  alertEmail: "cached@example.com",
  storeName: "Cached Store",
  uninstalledAt: null,
  summaryNoticeShownAt: new Date("2026-10-01T00:00:00Z"),
  summaryOptedInAt: null,
  ...over,
});

const ADMIN = { graphql: vi.fn() };

function enableEnv() {
  process.env.MERCHANT_ALERTS_ENABLED = "true";
  process.env.RESEND_API_KEY = "re_test";
  process.env.MERCHANT_ALERT_FROM = "Ghost Code <summary@example.com>";
  process.env.SHOPIFY_APP_URL = "https://app.example.com/";
}

type SendArgs = Parameters<typeof sendScanSummary>[0];
const send = (over: Partial<SendArgs> = {}) =>
  sendScanSummary({
    shop: shop(),
    scan: { id: "scan-1" },
    changes: changes(),
    baseline: "last_summary",
    admin: ADMIN,
    latestSummary: null,
    ...over,
  });

/** The subject, text and HTML of the one email sent. */
function sentEmail(): {
  subject: string;
  text: string;
  html: string;
  to: string;
  headers: Record<string, string>;
} {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0];
  const body = JSON.parse(init.body);
  return {
    subject: body.subject,
    text: body.text,
    html: body.html,
    to: body.to,
    headers: init.headers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  enableEnv();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  m.record.mockResolvedValue({});
  m.ensureToken.mockResolvedValue("tok123");
  m.refresh.mockResolvedValue({ email: "fresh@example.com", storeName: "Fresh Store" });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Eligibility matrix
// ---------------------------------------------------------------------------

describe("eligibility matrix (consent, plan, toggle, install)", () => {
  it.each([
    ["Professional, notice shown", shop(), null],
    ["Standard, notice shown", shop({ plan: "Standard" }), null],
    [
      "opted in via Settings, notice never shown",
      shop({ summaryNoticeShownAt: null, summaryOptedInAt: new Date() }),
      null,
    ],
    ["Free is never eligible", shop({ plan: "free" }), "plan_not_eligible"],
    ["toggle off", shop({ alertsEnabled: false }), "shop_opted_out"],
    [
      "toggle off even after opting in",
      shop({ alertsEnabled: false, summaryOptedInAt: new Date() }),
      "shop_opted_out",
    ],
    ["uninstalled", shop({ uninstalledAt: new Date() }), "shop_uninstalled"],
    [
      "no notice shown and never opted in",
      shop({ summaryNoticeShownAt: null, summaryOptedInAt: null }),
      "no_consent",
    ],
  ])("%s", (_label, s, reason) => {
    expect(summaryShopSkipReason(s)).toBe(reason);
  });

  it("a shop already paid before this shipped (alertsEnabled default true, no notice, no opt-in) is NOT eligible", async () => {
    // paw-naturals shape: paid, toggle at its default ON, consent fields never
    // backfilled. It must get nothing unless the merchant opts in.
    const legacy = shop({
      plan: "Professional",
      alertsEnabled: true,
      summaryNoticeShownAt: null,
      summaryOptedInAt: null,
    });
    expect(summaryShopSkipReason(legacy)).toBe("no_consent");
    expect(await send({ shop: legacy })).toEqual({ sent: false, reason: "no_consent" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it("the same legacy shop becomes eligible once it opts in itself", async () => {
    const optedIn = shop({ summaryNoticeShownAt: null, summaryOptedInAt: new Date() });
    expect(await send({ shop: optedIn })).toEqual({ sent: true, reason: "sent" });
  });

  it("uninstalled is checked before plan, toggle and consent", () => {
    expect(
      summaryShopSkipReason(
        shop({
          uninstalledAt: new Date(),
          plan: "free",
          alertsEnabled: false,
          summaryNoticeShownAt: null,
        }),
      ),
    ).toBe("shop_uninstalled");
  });

  it.each([
    ["MERCHANT_ALERTS_ENABLED", "disabled"],
    ["RESEND_API_KEY", "no_transport"],
    ["MERCHANT_ALERT_FROM", "no_sender"],
  ])("not configured (%s unset) => %s, nothing sent", async (envVar, reason) => {
    delete process.env[envVar];
    expect(await send()).toEqual({ sent: false, reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends without any postal address configured", async () => {
    delete process.env.MERCHANT_EMAIL_POSTAL_ADDRESS;
    expect(await send()).toEqual({ sent: true, reason: "sent" });
  });

  it("sends the text and the HTML version of the same body together", async () => {
    await send();
    const email = sentEmail();
    const opts = {
      storeName: "Fresh Store",
      shopDomain: SHOP_DOMAIN,
      cadence: "weekly" as const,
      changes: changes(),
      baseline: "last_summary" as const,
      scanUrl: "https://admin.shopify.com/store/my-store/apps/ghost-code/app/scans/scan-1",
      unsubscribeUrl: "https://app.example.com/unsubscribe#t=tok123",
    };
    expect(email.text).toBe(buildSummaryText(opts));
    expect(email.html).toBe(buildSummaryHtml(opts));
  });

  it("no owner email (none fetched, none cached) => no_recipient", async () => {
    m.refresh.mockResolvedValue({ email: null, storeName: null });
    expect(await send({ shop: shop({ alertEmail: null }) })).toEqual({
      sent: false,
      reason: "no_recipient",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recipient: the fresh owner email wins; the cached one is the fallback", async () => {
    await send();
    expect(sentEmail().to).toBe("fresh@example.com");
    fetchMock.mockClear();
    m.refresh.mockResolvedValue({ email: null, storeName: null });
    await send();
    expect(sentEmail().to).toBe("cached@example.com");
  });

  it("admin null skips the refresh and uses the cached email", async () => {
    await send({ admin: null });
    expect(m.refresh).not.toHaveBeenCalled();
    expect(sentEmail().to).toBe("cached@example.com");
  });

  it("store name: the freshly read one wins, then the cached one, then the domain", async () => {
    await send();
    expect(sentEmail().subject).toBe("GhostCode digest for Fresh Store");
    expect(sentEmail().text).toContain("digest for Fresh Store from GhostCode.");
    fetchMock.mockClear();
    m.refresh.mockResolvedValue({ email: "fresh@example.com", storeName: null });
    await send();
    expect(sentEmail().subject).toBe("GhostCode digest for Cached Store");
    fetchMock.mockClear();
    await send({ admin: null, shop: shop({ storeName: null }) });
    expect(sentEmail().subject).toBe("GhostCode digest for my-store.myshopify.com");
    expect(sentEmail().text).toContain("digest for my-store.myshopify.com from GhostCode.");
  });

  it("no SHOPIFY_APP_URL or no unsubscribe token => never sends", async () => {
    delete process.env.SHOPIFY_APP_URL;
    expect(await send()).toEqual({ sent: false, reason: "no_app_url" });
    enableEnv();
    m.ensureToken.mockResolvedValue(null);
    expect(await send()).toEqual({ sent: false, reason: "no_unsubscribe_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Changed / nothing changed
// ---------------------------------------------------------------------------

describe("nothing changed => no email", () => {
  it("zero new, zero fixed, no app changes: nothing sent, nothing recorded", async () => {
    expect(hasSummaryChanges(NO_CHANGES)).toBe(false);
    expect(await send({ changes: NO_CHANGES })).toEqual({
      sent: false,
      reason: "nothing_changed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
    // Nothing changed short-circuits before the owner-email fetch.
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it("open findings alone are not a change", () => {
    expect(hasSummaryChanges({ ...NO_CHANGES, openCount: 50 })).toBe(false);
  });

  it.each([
    ["a new finding", { newCount: 1 }],
    ["a fixed finding", { fixedCount: 1 }],
    ["an app no longer active", { inactiveApps: [app("Judge.me")] }],
    ["an app cleaned up", { cleanedApps: [app("Klaviyo")] }],
  ])("%s alone is a change and sends one email", async (_label, over) => {
    const c = { ...NO_CHANGES, ...over };
    expect(hasSummaryChanges(c)).toBe(true);
    expect(await send({ changes: c })).toEqual({ sent: true, reason: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency + throttle
// ---------------------------------------------------------------------------

describe("idempotency per scan and the cadence throttle", () => {
  it("a summary already recorded for THIS scan (Inngest retry) is never sent again", async () => {
    expect(
      await send({ latestSummary: { scanId: "scan-1", sentAt: new Date(Date.now() - 60_000) } }),
    ).toEqual({ sent: false, reason: "already_sent" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a per-scan Resend Idempotency-Key", async () => {
    await send();
    expect(sentEmail().headers["Idempotency-Key"]).toBe("summary-email:scan-1");
  });

  it("a ledger unique violation (row recorded by an earlier attempt) still counts as sent once", async () => {
    m.record.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    expect(await send()).toEqual({ sent: true, reason: "sent" });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("records counts reported, recipient and a content hash on success", async () => {
    const c = changes({ inactiveApps: [app("A"), app("B")], cleanedApps: [app("C")] });
    await send({ changes: c });
    expect(m.record).toHaveBeenCalledWith({
      shopId: "shop-1",
      scanId: "scan-1",
      findingSetHash: buildSummaryHash(c),
      newCount: 2,
      fixedCount: 1,
      inactiveAppCount: 2,
      cleanedAppCount: 1,
      recipient: "fresh@example.com",
    });
  });

  it.each([
    ["Professional", 6 * DAY, "throttled"],
    ["Professional", 8 * DAY, null],
    ["Standard", 20 * DAY, "throttled"],
    ["Standard", 28 * DAY, null],
  ])("%s, last summary %d ms ago => %s", (plan, ago, expected) => {
    const now = new Date("2026-10-09T12:00:00Z");
    expect(
      summaryRateSkipReason(
        plan,
        "scan-2",
        { scanId: "scan-1", sentAt: new Date(now.getTime() - ago) },
        now,
      ),
    ).toBe(expected);
  });

  it("scheduler jitter (91% of the window) never throttles; 89% does", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const at = (f: number) => ({ scanId: "old", sentAt: new Date(now.getTime() - 7 * DAY * f) });
    expect(summaryRateSkipReason("Professional", "new", at(0.91), now)).toBeNull();
    expect(summaryRateSkipReason("Professional", "new", at(0.89), now)).toBe("throttled");
  });

  it("throttled end to end: no send", async () => {
    expect(
      await send({ latestSummary: { scanId: "old", sentAt: new Date(Date.now() - DAY) } }),
    ).toEqual({ sent: false, reason: "throttled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Resend failure => send_failed, nothing recorded", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    expect(await send()).toEqual({ sent: false, reason: "send_failed" });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("never throws when a dependency throws", async () => {
    m.ensureToken.mockRejectedValue(new Error("db down"));
    expect(await send()).toEqual({ sent: false, reason: "exception" });
  });
});

// ---------------------------------------------------------------------------
// App removals in the period
// ---------------------------------------------------------------------------

describe("summarizeAppRemovals", () => {
  const PERIOD = new Set(["s2", "s3"]);
  const row = (over: Partial<SummaryRemovalRow>): SummaryRemovalRow => ({
    appName: "Judge.me",
    leftoverCount: 3,
    state: "REMOVED",
    detectedScanId: "s2",
    stateChangedScanId: null,
    detectedAt: new Date("2026-10-02T00:00:00Z"),
    ...over,
  });

  it("an app detected no longer active in the period and still REMOVED is listed", () => {
    expect(summarizeAppRemovals([row({})], PERIOD)).toEqual({
      inactiveApps: [app("Judge.me", 3)],
      cleanedApps: [],
    });
  });

  it("an app detected BEFORE the period (already reported) is not listed again", () => {
    expect(summarizeAppRemovals([row({ detectedScanId: "s1" })], PERIOD).inactiveApps).toEqual([]);
  });

  it("an app that went inactive and came back (REINSTALLED) within the period is omitted", () => {
    const back = row({ state: "REINSTALLED", stateChangedScanId: "s3" });
    expect(summarizeAppRemovals([back], PERIOD)).toEqual({ inactiveApps: [], cleanedApps: [] });
  });

  it("a REINSTALLED row of an app detected earlier is omitted too", () => {
    const back = row({ state: "REINSTALLED", detectedScanId: "s1", stateChangedScanId: "s2" });
    expect(summarizeAppRemovals([back], PERIOD)).toEqual({ inactiveApps: [], cleanedApps: [] });
  });

  it("leftovers cleaned up on a period scan are listed with the last leftover count", () => {
    const done = row({ state: "CLEANED", detectedScanId: "s1", stateChangedScanId: "s3" });
    expect(summarizeAppRemovals([done], PERIOD)).toEqual({
      inactiveApps: [],
      cleanedApps: [app("Judge.me", 3)],
    });
  });

  it("cleaned up before the period: not listed", () => {
    const done = row({ state: "CLEANED", detectedScanId: "s0", stateChangedScanId: "s1" });
    expect(summarizeAppRemovals([done], PERIOD).cleanedApps).toEqual([]);
  });

  it("one line per app: newly inactive wins over an older cleaned-up row", () => {
    const rows = [
      row({ state: "CLEANED", detectedScanId: "s0", stateChangedScanId: "s2" }),
      row({ detectedScanId: "s3", leftoverCount: 5, detectedAt: new Date("2026-10-03") }),
    ];
    expect(summarizeAppRemovals(rows, PERIOD)).toEqual({
      inactiveApps: [app("Judge.me", 5)],
      cleanedApps: [],
    });
  });

  it("sorts each list by app name", () => {
    const rows = [row({ appName: "Yotpo" }), row({ appName: "Avada" })];
    expect(summarizeAppRemovals(rows, PERIOD).inactiveApps.map((a) => a.appName)).toEqual([
      "Avada",
      "Yotpo",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Finding changes (same guards as the in-app diff)
// ---------------------------------------------------------------------------

describe("computeFindingChanges", () => {
  const ALL = Object.values(FindingType);
  const NO_GAPS = {
    skippedCategories: [] as string[],
    cappedCategories: [] as string[],
    unreachableCategories: [] as string[],
  };
  const f = (filename: string, findingType: string = FindingType.GHOST_SCRIPT, appName = "X") => ({
    filename,
    findingType,
    codeSnippet: `<script src="${filename}"></script>`,
    lineNumber: 1,
    severity: "HIGH",
    appName,
    description: "d",
  });
  const NO_IGNORES = { fingerprints: new Set<string>(), appNames: new Set<string>() };
  const run = (over: Partial<Parameters<typeof computeFindingChanges>[0]> = {}) =>
    computeFindingChanges({
      currentFindings: [f("a.liquid"), f("b.liquid")],
      currentCoverage: { ...NO_GAPS, skippedFiles: [], liveFindingTypes: ALL },
      currentLiveFindingTypes: ALL,
      baseline: { ...NO_GAPS, findings: [f("a.liquid"), f("c.liquid")], liveFindingTypes: ALL },
      ignores: NO_IGNORES,
      ...over,
    });

  it("counts new, fixed and open", () => {
    expect(run()).toEqual({ ok: true, newCount: 1, fixedCount: 1, openCount: 2 });
  });

  it("identical scans: zero new, zero fixed", () => {
    expect(
      run({
        baseline: { ...NO_GAPS, findings: [f("a.liquid"), f("b.liquid")], liveFindingTypes: ALL },
      }),
    ).toEqual({ ok: true, newCount: 0, fixedCount: 0, openCount: 2 });
  });

  it("a permission grant (category not audited by the baseline) is not counted as new", () => {
    const product = f("n/a", FindingType.GHOST_TAG);
    const r = run({
      currentFindings: [f("a.liquid"), f("c.liquid"), product],
      baseline: {
        ...NO_GAPS,
        skippedCategories: [FindingType.GHOST_TAG],
        findings: [f("a.liquid"), f("c.liquid")],
        liveFindingTypes: ALL,
      },
    });
    expect(r).toEqual({ ok: true, newCount: 0, fixedCount: 0, openCount: 3 });
  });

  it("a newly live detector (absent from the baseline's live set) is not counted as new", () => {
    const embed = f("config/settings_data.json", FindingType.APP_EMBED_OFF);
    const r = run({
      currentFindings: [f("a.liquid"), f("c.liquid"), embed],
      baseline: {
        ...NO_GAPS,
        findings: [f("a.liquid"), f("c.liquid")],
        liveFindingTypes: ALL.filter((t) => t !== FindingType.APP_EMBED_OFF),
      },
    });
    expect(r).toMatchObject({ ok: true, newCount: 0 });
  });

  it("a category the CURRENT scan did not audit is never counted as fixed", () => {
    const product = f("n/a", FindingType.GHOST_TAG);
    const r = run({
      currentFindings: [f("a.liquid")],
      currentCoverage: {
        ...NO_GAPS,
        skippedCategories: [FindingType.GHOST_TAG],
        skippedFiles: [],
        liveFindingTypes: ALL,
      },
      baseline: { ...NO_GAPS, findings: [f("a.liquid"), product], liveFindingTypes: ALL },
    });
    expect(r).toMatchObject({ ok: true, fixedCount: 0 });
  });

  it("ignored findings count as neither new nor open", () => {
    const r = run({ ignores: { fingerprints: new Set(), appNames: new Set(["X"]) } });
    expect(r).toEqual({ ok: true, newCount: 0, fixedCount: 0, openCount: 0 });
  });

  it("an unversioned baseline or current scan cannot be judged", () => {
    expect(run({ baseline: { ...NO_GAPS, findings: [], liveFindingTypes: null } })).toEqual({
      ok: false,
      reason: "baseline_unversioned",
    });
    expect(run({ currentLiveFindingTypes: null })).toEqual({
      ok: false,
      reason: "current_unversioned",
    });
  });
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

describe("subject", () => {
  it("is 'GhostCode digest for {Store Name}'", () => {
    expect(buildSummarySubject("Paw Naturals", SHOP_DOMAIN)).toBe(
      "GhostCode digest for Paw Naturals",
    );
  });

  it.each([
    ["Professional (weekly)", "Professional"],
    ["Standard (monthly)", "Standard"],
  ])(
    "%s gets the same subject whatever changed: no cadence, no app names",
    async (_label, plan) => {
      await send({
        shop: shop({ plan }),
        changes: changes({ inactiveApps: [app("Judge.me")], cleanedApps: [app("Klaviyo")] }),
      });
      const { subject } = sentEmail();
      expect(subject).toBe("GhostCode digest for Fresh Store");
      expect(subject).not.toMatch(/Judge\.me|Klaviyo|weekly|monthly|\[|\]/);
    },
  );

  it("falls back to the myshopify domain when the store name is null or blank", () => {
    expect(buildSummarySubject(null, SHOP_DOMAIN)).toBe(
      "GhostCode digest for my-store.myshopify.com",
    );
    expect(buildSummarySubject(" \n\t ", SHOP_DOMAIN)).toBe(
      "GhostCode digest for my-store.myshopify.com",
    );
  });

  it("strips newlines and control characters (no header injection)", () => {
    const subject = buildSummarySubject("Evil\r\nBcc: x@example.com\u0000\u200bShop", SHOP_DOMAIN);
    expect(subject).toBe("GhostCode digest for Evil Bcc: x@example.com Shop");
    expect(subject).not.toMatch(/[\p{Cc}\u200b]/u);
  });

  it(`caps the store name at ${MAX_STORE_NAME_IN_EMAIL} characters`, () => {
    const long = "A".repeat(MAX_STORE_NAME_IN_EMAIL + 40);
    expect(buildSummarySubject(long, SHOP_DOMAIN)).toBe(
      `GhostCode digest for ${"A".repeat(MAX_STORE_NAME_IN_EMAIL)}`,
    );
    // Never splits an emoji (surrogate pair) at the cap.
    const name = storeNameForEmail("😀".repeat(MAX_STORE_NAME_IN_EMAIL + 1), SHOP_DOMAIN);
    expect(Array.from(name)).toHaveLength(MAX_STORE_NAME_IN_EMAIL);
    expect(name).toBe("😀".repeat(MAX_STORE_NAME_IN_EMAIL));
  });

  it("keeps a normal store name as is", () => {
    expect(storeNameForEmail("Tom & Jerry's Pet Shop", SHOP_DOMAIN)).toBe("Tom & Jerry's Pet Shop");
  });
});

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

describe("body", () => {
  const opts = (
    over: Partial<Parameters<typeof buildSummaryText>[0]> = {},
  ): Parameters<typeof buildSummaryText>[0] => ({
    storeName: "Paw Naturals",
    shopDomain: SHOP_DOMAIN,
    cadence: "weekly",
    changes: changes({ inactiveApps: [app("Judge.me", 3)], cleanedApps: [app("Klaviyo", 4)] }),
    baseline: "last_summary",
    scanUrl: "https://admin.shopify.com/store/my-store/apps/ghost-code/app/scans/scan-1",
    unsubscribeUrl: "https://app.example.com/unsubscribe#t=tok",
    ...over,
  });
  const text = (over: Partial<Parameters<typeof buildSummaryText>[0]> = {}) =>
    buildSummaryText(opts(over));
  const html = (over: Partial<Parameters<typeof buildSummaryHtml>[0]> = {}) =>
    buildSummaryHtml(opts(over));

  it("renders the full body in order", () => {
    expect(text()).toBe(
      [
        "Here is your weekly digest for Paw Naturals from GhostCode.",
        "",
        "- Judge.me is no longer active. It left 3 items behind.",
        "",
        "- Klaviyo: cleaned up. All 4 items it left are gone.",
        "",
        "New since your last summary: 2",
        "Fixed since your last summary: 1",
        "Still in your theme: 7",
        "",
        "See the details in GhostCode:",
        "https://admin.shopify.com/store/my-store/apps/ghost-code/app/scans/scan-1",
        "",
        "Alpenglow Software LLC",
        "support@alpenglowsoftware.com",
        "Unsubscribe: https://app.example.com/unsubscribe#t=tok",
      ].join("\n"),
    );
  });

  it("drops the old 'You're getting this', 'Turn off' and postal lines", () => {
    for (const t of [text(), text({ cadence: "monthly" }), html()]) {
      expect(t).not.toContain("You're getting this");
      expect(t).not.toContain("summary emails are on");
      expect(t).not.toContain("Turn off these emails");
      expect(t).not.toMatch(/scans your store every/);
      expect(t).not.toContain("Alpenglow Software LLC, support@");
    }
  });

  describe("HTML version", () => {
    /** Visible text of the HTML, tags dropped and entities decoded, in order. */
    const visible = (h: string) =>
      h
        .replace(/<br>/g, "\n")
        .replace(/<\/tr>/g, "\n")
        .replace(/<\/li>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

    it("carries the same facts as the text, in the same order", () => {
      expect(visible(html())).toEqual([
        "Here is your weekly digest for Paw Naturals from GhostCode.",
        "Judge.me is no longer active. It left 3 items behind.",
        "Klaviyo: cleaned up. All 4 items it left are gone.",
        "New since your last summary: 2",
        "Fixed since your last summary: 1",
        "Still in your theme: 7",
        "See the details in GhostCode",
        "Alpenglow Software LLC",
        "support@alpenglowsoftware.com",
        "Unsubscribe",
      ]);
    });

    it("renders app lines as a real bullet list, without the text version's '- '", () => {
      const h = html();
      expect(h).toContain(
        '<li style="margin:0 0 4px">Judge.me is no longer active. It left 3 items behind.</li>',
      );
      expect(h).toMatch(/<ul style="[^"]*">/);
      expect(h).not.toContain(">- ");
      expect(text()).toContain("- Judge.me is no longer active.");
    });

    it("links the scan, the support mailbox and the unsubscribe URL", () => {
      const h = html();
      expect(h).toContain(
        '<a href="https://admin.shopify.com/store/my-store/apps/ghost-code/app/scans/scan-1" style="color:#1a56db;text-decoration:underline">See the details in GhostCode</a>',
      );
      expect(h).toMatch(
        /<a href="mailto:support@alpenglowsoftware\.com"[^>]*>support@alpenglowsoftware\.com<\/a>/,
      );
      expect(h).toMatch(
        /<a href="https:\/\/app\.example\.com\/unsubscribe#t=tok"[^>]*>Unsubscribe<\/a>/,
      );
      expect(h.match(/<a /g)).toHaveLength(3);
    });

    it("shows the Alpenglow logo (https, 32x32, alt text) left of the sender name", () => {
      expect(ALPENGLOW_LOGO_URL).toBe("https://alpenglowsoftware.com/assets/icons/alpenglow.png");
      const h = html();
      expect(h).toContain(
        '<img src="https://alpenglowsoftware.com/assets/icons/alpenglow.png" width="32" height="32" alt="Alpenglow Software LLC" style="border-radius:6px;display:block">',
      );
      expect(h.indexOf("<img ")).toBeLessThan(h.indexOf("Alpenglow Software LLC<br>"));
      expect(h.match(/<img /g)).toHaveLength(1);
    });

    it("is email-client safe: tables, inline styles, no scripts or external CSS, max 560px", () => {
      const h = html();
      expect(h.startsWith("<!doctype html>")).toBe(true);
      expect(h).toContain('role="presentation"');
      expect(h).toContain("max-width:560px");
      expect(h).toContain("background:#ffffff");
      expect(h).toMatch(/font-family:-apple-system,/);
      expect(h).not.toMatch(/<script|<style|<link|class=|javascript:/i);
      expect(h).not.toMatch(/src="http:/);
    });

    it("omits empty app sections", () => {
      const h = html({ changes: changes() });
      expect(h).not.toContain("no longer active");
      expect(h).not.toContain("cleaned up");
    });

    it("escapes every interpolated value (app names, store name, URLs in attributes)", () => {
      const h = html({
        storeName: 'x<script>alert(1)</script>&"y',
        shopDomain: "z.myshopify.com",
        changes: changes({
          inactiveApps: [app("<script>alert(1)</script>", 1)],
          cleanedApps: [app(`Tom & Jerry's "Reviews"`, 2)],
        }),
        scanUrl: 'https://admin.shopify.com/a?x=1&y="><script>',
        unsubscribeUrl: 'https://app.example.com/unsubscribe#t=a&b"c',
      });
      expect(h).not.toContain("<script");
      expect(h).toContain(">&lt;script&gt;alert(1)&lt;/script&gt; is no longer active.");
      expect(h).toContain(
        "digest for x&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;y from GhostCode.",
      );
      expect(h).toContain(">Tom &amp; Jerry&#39;s &quot;Reviews&quot;: cleaned up.");
      expect(h).toContain('href="https://admin.shopify.com/a?x=1&amp;y=&quot;&gt;&lt;script&gt;"');
      expect(h).toContain('href="https://app.example.com/unsubscribe#t=a&amp;b&quot;c"');
    });
  });

  it("singular item wording", () => {
    const t = text({
      changes: changes({ inactiveApps: [app("A", 1)], cleanedApps: [app("B", 1)] }),
    });
    expect(t).toContain("- A is no longer active. It left 1 item behind.");
    expect(t).toContain("- B: cleaned up. The 1 item it left is gone.");
  });

  it("omits empty app sections", () => {
    const t = text({ changes: changes() });
    expect(t).not.toContain("no longer active");
    expect(t).not.toContain("cleaned up");
    expect(t.startsWith("Here is your weekly digest")).toBe(true);
  });

  it("Standard's opening line says monthly", () => {
    expect(text({ cadence: "monthly" }).split("\n")[0]).toBe(
      "Here is your monthly digest for Paw Naturals from GhostCode.",
    );
    expect(html({ cadence: "monthly" })).toContain(
      "Here is your monthly digest for Paw Naturals from GhostCode.",
    );
  });

  it("opening line falls back to the domain and sanitizes the name", () => {
    expect(text({ storeName: null }).split("\n")[0]).toBe(
      "Here is your weekly digest for my-store.myshopify.com from GhostCode.",
    );
    expect(text({ storeName: "Two\nLines" }).split("\n")[0]).toBe(
      "Here is your weekly digest for Two Lines from GhostCode.",
    );
  });

  it("brand is 'GhostCode' (one word) everywhere in the email", () => {
    for (const t of [text(), html(), buildSummarySubject("S", SHOP_DOMAIN)]) {
      expect(t).not.toContain("Ghost Code");
    }
  });

  it("first summary (no ledger baseline) says 'since your previous scan'", () => {
    const t = text({ baseline: "previous_scan" });
    expect(t).toContain("New since your previous scan: 2");
    expect(t).toContain("Fixed since your previous scan: 1");
    expect(t).not.toContain("last summary");
  });

  it.each([
    ["inactive", "inactiveApps", "is no longer active"],
    ["cleaned", "cleanedApps", "cleaned up"],
  ] as const)("caps the %s list at %s apps then '- and K more'", (_l, key, phrase) => {
    const many = Array.from({ length: MAX_APPS_IN_EMAIL + 3 }, (_, i) => app(`App${i}`));
    const t = text({ changes: { ...NO_CHANGES, [key]: many } });
    expect(t.split("\n").filter((l) => l.includes(phrase))).toHaveLength(MAX_APPS_IN_EMAIL);
    expect(t).toContain("- and 3 more");
  });

  it("exactly 5 apps: no 'and more' line", () => {
    const five = Array.from({ length: MAX_APPS_IN_EMAIL }, (_, i) => app(`App${i}`));
    expect(text({ changes: { ...NO_CHANGES, inactiveApps: five } })).not.toContain("more");
  });

  describe("never contains forbidden content", () => {
    const bodies = () => {
      const many = Array.from({ length: 8 }, (_, i) => app(`App${i}`, i + 1));
      return [
        text(),
        text({ cadence: "monthly", baseline: "previous_scan" }),
        text({ changes: { ...NO_CHANGES, newCount: 1, inactiveApps: many, cleanedApps: many } }),
        text({ changes: { ...NO_CHANGES, cleanedApps: [app("Solo", 1)] } }),
        html(),
        html({ changes: { ...NO_CHANGES, newCount: 1, inactiveApps: many, cleanedApps: many } }),
        // The logo's public-site path ("assets/icons/...") is not a theme path.
      ].map((b) => b.replace(ALPENGLOW_LOGO_URL, "LOGO_URL"));
    };
    const subjects = [
      buildSummarySubject("Paw Naturals", SHOP_DOMAIN),
      buildSummarySubject(null, SHOP_DOMAIN),
    ];
    const all = () => [...bodies(), ...subjects];

    it("no 'removed' or 'uninstalled' claim about apps", () => {
      for (const s of all()) expect(s).not.toMatch(/\b(removed|uninstall(ed)?)\b/i);
    });

    it("no em dash or en dash", () => {
      for (const s of all()) expect(s).not.toMatch(/[—–]/);
    });

    it("no upsell, plan pitch or discount", () => {
      for (const s of all()) {
        expect(s).not.toMatch(
          /\b(upgrade|discount|offer|% off|trial|Professional|Standard|plan|pricing|save)\b/i,
        );
      }
    });

    it("no code snippets, file names or theme file paths", () => {
      for (const s of all()) {
        expect(s).not.toMatch(/<script|<link|\{%|\{\{/);
        expect(s).not.toMatch(/\.(liquid|js|css|json)\b/);
        expect(s).not.toMatch(/\b(layout|sections|snippets|templates|assets|config)\//);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

describe("recipient PII never reaches logs", () => {
  const EMAIL = "fresh@example.com";
  const prismaStyleError = () =>
    Object.assign(
      new Error(
        `Invalid \`prisma.merchantAlert.create()\` invocation: data: { recipient: "${EMAIL}" }`,
      ),
      { name: "PrismaClientValidationError", code: "P2000" },
    );

  it("a ledger write failure logs name/code only, not the address", async () => {
    m.record.mockRejectedValue(prismaStyleError());
    expect(await send()).toEqual({ sent: true, reason: "sent_not_recorded" });
    const calls = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(calls).not.toContain(EMAIL);
    expect(calls).toContain("P2000");
  });

  it("an exception in the chain logs name/code only, not the address", async () => {
    m.ensureToken.mockRejectedValue(prismaStyleError());
    expect(await send()).toEqual({ sent: false, reason: "exception" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(EMAIL);
  });
});
