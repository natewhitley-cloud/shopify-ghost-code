/**
 * gc-tib.22: the Professional free-trial limit end to end through preflight,
 * requestCleanCopy and the worker (fake Shopify + fake DB).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  fake: null as unknown as { db: unknown },
  manifest: null as unknown,
  ignores: { fingerprints: new Set<string>(), appNames: new Set<string>() },
  send: vi.fn(),
}));
vi.mock("../../app/db.server", () => ({
  get default() {
    return holder.fake.db;
  },
}));
vi.mock("../../app/models/scan-manifest.server", () => ({
  getScanManifest: vi.fn(async () => holder.manifest),
}));
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(async () => holder.ignores),
}));
vi.mock("../../inngest/client", () => ({ inngest: { send: holder.send } }));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createFakeDb,
  DEFAULT_FINDINGS,
  FakeShopify,
  type FakeDb,
  MAIN_ID,
  manifestFor,
  SCAN_ID,
  seed,
  SHOP_ID,
  THEME_FILES,
} from "./clean-copy.fakes";
import { createCleanCopyAdmin } from "../../app/services/clean-copy-admin.server";
import {
  checkCopyReady,
  cleanCopyTrial,
  ensureCopyTheme,
  preflightCleanCopy,
  requestCleanCopy,
  TRIAL_CLEAN_COPY_LIMIT,
  writeCleanCopy,
  type PreflightInput,
} from "../../app/services/clean-copy.server";

let fake: FakeDb;
let shop: FakeShopify;
let admin: ReturnType<typeof createCleanCopyAdmin>;

const NOW = new Date("2026-11-12T12:00:00Z");
const IN_TRIAL = {
  name: "Professional",
  status: "ACTIVE",
  createdAt: "2026-11-10T09:00:00Z",
  trialDays: 7,
};

beforeEach(() => {
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  fake = createFakeDb();
  holder.fake = fake;
  holder.manifest = manifestFor();
  holder.ignores = { fingerprints: new Set(), appNames: new Set() };
  holder.send.mockReset().mockResolvedValue(undefined);
  seed(fake);
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  shop.subscriptions = [IN_TRIAL];
  admin = createCleanCopyAdmin(shop);
});

afterEach(() => {
  expect(shop.mutationTargets()).not.toContain(MAIN_ID);
  vi.unstubAllEnvs();
});

const ALL_IDS = DEFAULT_FINDINGS.map((f) => f.id);

const pf = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  shopId: SHOP_ID,
  scanId: SCAN_ID,
  findingIds: ALL_IDS,
  confirmedApps: ["Ghost App"],
  grantedScopes: ["read_themes", "write_themes"],
  admin,
  now: NOW,
  ...over,
});

async function runAll(runId: string) {
  const dup = await ensureCopyTheme(admin, runId);
  if (!("copyThemeId" in dup)) throw new Error("no copy");
  while ((await checkCopyReady(admin, runId, dup.copyThemeId, false)) === "processing");
  await writeCleanCopy(admin, runId, { sleep: async () => {} });
}

const removedCount = () => fake.state.fixItems.filter((i) => i.status === "removed").length;

describe("cleanCopyTrial", () => {
  it("in trial before the end, not in trial at or after it", async () => {
    expect(await cleanCopyTrial(admin, NOW)).toEqual({
      ok: true,
      trial: { endsAt: new Date("2026-11-18T00:00:00Z") },
    });
    expect(await cleanCopyTrial(admin, new Date("2026-11-18T00:00:00Z"))).toEqual({
      ok: true,
      trial: null,
    });
  });

  it("fails closed: unreadable -> ADMIN_UNAVAILABLE, denied -> ACCESS_DENIED", async () => {
    shop.overrides.CleanCopySubscriptions = () => new Error("socket hang up");
    expect(await cleanCopyTrial(admin, NOW)).toEqual({ ok: false, reason: "ADMIN_UNAVAILABLE" });
    shop.overrides.CleanCopySubscriptions = () => ({
      errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }],
    });
    expect(await cleanCopyTrial(admin, NOW)).toEqual({ ok: false, reason: "ACCESS_DENIED" });
  });

  it("no active Professional subscription -> NOT_PROFESSIONAL, whatever is stored", async () => {
    shop.subscriptions = [{ ...IN_TRIAL, name: "Standard" }];
    expect(await cleanCopyTrial(admin, NOW)).toEqual({ ok: false, reason: "NOT_PROFESSIONAL" });
  });
});

describe("preflight and request during the trial", () => {
  it("the fixture selects exactly the limit", () => {
    expect(ALL_IDS).toHaveLength(TRIAL_CLEAN_COPY_LIMIT);
  });

  it("a selection within the limit makes a trial run", async () => {
    const pre = await preflightCleanCopy(pf());
    expect(pre).toMatchObject({ ok: true, trialLimit: TRIAL_CLEAN_COPY_LIMIT });
    const res = await requestCleanCopy(pf());
    expect(res.ok).toBe(true);
    expect(fake.state.fixRuns[0]).toMatchObject({ duringTrial: true });
  });

  it("paid (trial over): no trial limit, run not marked", async () => {
    const pre = await preflightCleanCopy(pf({ now: new Date("2026-12-01T00:00:00Z") }));
    expect(pre.ok).toBe(true);
    expect(pre.ok && "trialLimit" in pre).toBe(false);
    await requestCleanCopy(pf({ now: new Date("2026-12-01T00:00:00Z") }));
    expect(fake.state.fixRuns[0]).toMatchObject({ duringTrial: false });
  });

  it("all 5 removed, then any further selection is refused TRIAL_LIMIT", async () => {
    const res = await requestCleanCopy(pf());
    if (!res.ok) throw new Error(res.reason);
    await runAll(res.runId);
    expect(removedCount()).toBe(5);
    fake.state.fixRuns[0].status = "completed";
    expect(await requestCleanCopy(pf({ findingIds: [ALL_IDS[0]] }))).toEqual({
      ok: false,
      reason: "TRIAL_LIMIT",
    });
    expect(fake.state.fixRuns).toHaveLength(1);
  });

  it("a refused TRIAL_LIMIT preflight makes no theme call after the subscription read", async () => {
    const res = await requestCleanCopy(pf());
    if (!res.ok) throw new Error(res.reason);
    await runAll(res.runId);
    fake.state.fixRuns[0].status = "completed";
    const before = shop.calls.length;
    await requestCleanCopy(pf({ findingIds: [ALL_IDS[0]] }));
    expect(shop.calls.slice(before).map((c) => c.op)).toEqual(["CleanCopySubscriptions"]);
  });

  it("the same limit holds after the trial if the shop is back in a trial later", async () => {
    const res = await requestCleanCopy(pf());
    if (!res.ok) throw new Error(res.reason);
    await runAll(res.runId);
    fake.state.fixRuns[0].status = "completed";
    // Paid now: allowed again, and a paid run doesn't use the limit.
    const later = new Date("2026-12-01T00:00:00Z");
    expect((await preflightCleanCopy(pf({ now: later }))).ok).toBe(true);
    // Back in a (prorated) trial: the earlier 5 still count.
    shop.subscriptions = [{ ...IN_TRIAL, createdAt: "2026-12-05T00:00:00Z", trialDays: 2 }];
    expect(
      await preflightCleanCopy(
        pf({ findingIds: [ALL_IDS[0]], now: new Date("2026-12-05T12:00:00Z") }),
      ),
    ).toEqual({ ok: false, reason: "TRIAL_LIMIT" });
  });

  it("unreadable subscription refuses before any run (fail closed)", async () => {
    shop.overrides.CleanCopySubscriptions = () => ({ data: { currentAppInstallation: null } });
    expect(await requestCleanCopy(pf())).toEqual({ ok: false, reason: "ADMIN_UNAVAILABLE" });
    expect(fake.state.fixRuns).toHaveLength(0);
  });

  it("stored plan Professional but no live subscription -> NOT_PROFESSIONAL", async () => {
    shop.subscriptions = [];
    expect(await requestCleanCopy(pf())).toEqual({ ok: false, reason: "NOT_PROFESSIONAL" });
    expect(fake.state.fixRuns).toHaveLength(0);
  });

  it("the race the early check can't see is caught under the lock", async () => {
    // Another trial run's 5 removals land after preflight counted (during its
    // later MAIN theme read) and before createFixRun.
    let injected = false;
    shop.overrides.CleanCopyMain = () => {
      if (!injected) {
        injected = true;
        fake.state.fixRuns.push({
          id: "run-other",
          shopId: SHOP_ID,
          status: "completed",
          duringTrial: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        for (let n = 0; n < 5; n++) {
          fake.state.fixItems.push({
            id: `x${n}`,
            fixRunId: "run-other",
            findingId: `o${n}`,
            status: "removed",
          });
        }
      }
      return undefined;
    };
    expect(await requestCleanCopy(pf())).toEqual({
      ok: false,
      reason: "TRIAL_LIMIT",
      used: 5,
      limit: TRIAL_CLEAN_COPY_LIMIT,
    });
    expect(fake.state.fixRuns.map((r) => r.id)).toEqual(["run-other"]);
  });

  it("items that were skipped in a trial run don't use the limit", async () => {
    // Change one file so its items are skipped FILE_CHANGED.
    const res = await requestCleanCopy(pf());
    if (!res.ok) throw new Error(res.reason);
    const dup = await ensureCopyTheme(admin, res.runId);
    if (!("copyThemeId" in dup)) throw new Error("no copy");
    while ((await checkCopyReady(admin, res.runId, dup.copyThemeId, false)) === "processing");
    const copy = shop.themes.get(dup.copyThemeId)!;
    const [firstFile] = [...new Set(DEFAULT_FINDINGS.map((f) => f.filename))];
    copy.files.set(firstFile, `${copy.files.get(firstFile)}\n<!-- edited -->`);
    await writeCleanCopy(admin, res.runId, { sleep: async () => {} });
    const skipped = fake.state.fixItems.filter((i) => i.status === "skipped").length;
    expect(skipped).toBeGreaterThan(0);
    fake.state.fixRuns[0].status = "partial";
    const ids = ALL_IDS.slice(0, skipped);
    expect((await preflightCleanCopy(pf({ findingIds: ids }))).ok).toBe(true);
    expect(await preflightCleanCopy(pf({ findingIds: ALL_IDS.slice(0, skipped + 1) }))).toEqual({
      ok: false,
      reason: "TRIAL_LIMIT",
    });
  });
});
