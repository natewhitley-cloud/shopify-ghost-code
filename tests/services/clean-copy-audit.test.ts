/**
 * gc-tib batch audit regressions for the clean-copy service (H1, M-a, M-e,
 * M-f, M-i, M-j, M-k, logic 11, logic 15, sec 7, sec 8), from the auditors'
 * probes (.cache/audit-logic/probe.test.ts, .cache/audit-sec/orch.test.ts).
 *
 * Same harness as clean-copy.server.test.ts: Prisma fake, real adapter over
 * FakeShopify, and the MAIN-never-written invariant after every test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const holder = vi.hoisted(() => ({
  fake: null as unknown as { db: unknown },
  manifest: null as unknown,
  ignores: { fingerprints: new Set<string>(), appNames: new Set<string>() },
  send: vi.fn(),
  logs: [] as unknown[],
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
  logger: {
    info: (...a: unknown[]) => holder.logs.push(a),
    warn: (...a: unknown[]) => holder.logs.push(a),
    error: (...a: unknown[]) => holder.logs.push(a),
  },
}));

import {
  BODY_MARKER,
  createFakeDb,
  DEFAULT_FINDINGS,
  FakeShopify,
  type FakeDb,
  finding,
  MAIN_ID,
  manifestFor,
  SCAN_ID,
  SCRIPT_TAG,
  seed,
  SHOP_ID,
  THEME_FILES,
} from "./clean-copy.fakes";
import { finalizeFixRun } from "../../app/models/fix-run.server";
import { createCleanCopyAdmin, safeCode } from "../../app/services/clean-copy-admin.server";
import {
  checkCleanCopyFreshness,
  checkCopyReady,
  ensureCopyTheme,
  preflightCleanCopy,
  requestCleanCopy,
  writeCleanCopy,
  type PreflightInput,
} from "../../app/services/clean-copy.server";

let fake: FakeDb;
let shop: FakeShopify;
let admin: ReturnType<typeof createCleanCopyAdmin>;

beforeEach(() => {
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  fake = createFakeDb();
  holder.fake = fake;
  holder.manifest = manifestFor();
  holder.ignores = { fingerprints: new Set(), appNames: new Set() };
  holder.logs = [];
  holder.send.mockReset().mockResolvedValue(undefined);
  seed(fake);
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  admin = createCleanCopyAdmin(shop);
});

afterEach(() => {
  expect(shop.mutationTargets()).not.toContain(MAIN_ID);
  expect(Object.fromEntries(shop.themes.get(MAIN_ID)!.files)).toEqual(THEME_FILES);
  vi.unstubAllEnvs();
});

const pf = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  shopId: SHOP_ID,
  scanId: SCAN_ID,
  findingIds: DEFAULT_FINDINGS.map((f) => f.id),
  confirmedApps: ["Ghost App"],
  grantedScopes: ["read_themes", "write_themes"],
  admin,
  ...over,
});

async function startRun(findingIds = DEFAULT_FINDINGS.map((f) => f.id)) {
  const res = await requestCleanCopy(pf({ findingIds }));
  if (!res.ok) throw new Error(`request refused: ${res.reason}`);
  return res.runId;
}

async function readyCopy(runId: string) {
  const dup = await ensureCopyTheme(admin, runId);
  if (!("copyThemeId" in dup)) throw new Error("no copy");
  while ((await checkCopyReady(admin, runId, dup.copyThemeId, false)) === "processing");
  return dup.copyThemeId;
}

const runOf = (id: string) => fake.state.fixRuns.find((r) => r.id === id)!;
const itemsOf = (id: string): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    fake.state.fixItems.filter((i) => i.fixRunId === id).map((i) => [i.findingId, i]),
  );
const noSleep = { sleep: async () => {} };

describe("H1: a retry that finds a recorded write at neither md5 is unverified (probe P1)", () => {
  it("POST_WRITE_MISMATCH + doNotPublish, never skipped FILE_CHANGED", async () => {
    const runId = await startRun(["f-script-1", "f-other"]);
    await readyCopy(runId);
    const otherFile = "snippets/other.liquid";
    // Shopify stores f-other's file differently from what we sent.
    shop.upsertTransform = (f, c) => (f === otherFile ? `${c}\n<!-- normalized -->` : c);
    let reads = 0;
    shop.overrides.CleanCopyFiles = () => (++reads === 2 ? new Error("THROTTLED") : undefined);
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toThrow();
    shop.overrides = {};
    await writeCleanCopy(admin, runId, noSleep);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "POST_WRITE_MISMATCH",
    });
    expect(itemsOf(runId)["f-script-1"].status).toBe("removed");
    expect(runOf(runId).doNotPublish).toBe(true);
    expect(shop.count("CleanCopyUpsert")).toBe(1);
  });

  it("a recorded write whose file disappeared is also unverified", async () => {
    const runId = await startRun(["f-other"]);
    const copyId = await readyCopy(runId);
    let reads = 0;
    shop.overrides.CleanCopyFiles = () => (++reads === 2 ? new Error("THROTTLED") : undefined);
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toThrow();
    shop.overrides = {};
    shop.themes.get(copyId)!.files.delete("snippets/other.liquid");
    await writeCleanCopy(admin, runId, noSleep);
    expect(itemsOf(runId)["f-other"].reasonCode).toBe("POST_WRITE_MISMATCH");
    expect(runOf(runId).doNotPublish).toBe(true);
  });
});

describe("M-a: the copy is published while we write (probe O1)", () => {
  it("published between the guard and the upsert: items failed, run failed, doNotPublish", async () => {
    const runId = await startRun(["f-other"]);
    const copyId = await readyCopy(runId);
    shop.overrides.CleanCopyUpsert = () => {
      shop.themes.get(MAIN_ID)!.role = "UNPUBLISHED";
      shop.themes.get(copyId)!.role = "MAIN";
      return undefined;
    };
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "COPY_PUBLISHED_DURING_WRITE",
    });
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "COPY_PUBLISHED_DURING_WRITE",
    });
    expect(runOf(runId)).toMatchObject({
      status: "failed",
      failureReason: "COPY_PUBLISHED_DURING_WRITE",
      doNotPublish: true,
    });
    // restore for the invariant
    shop.themes.get(copyId)!.role = "UNPUBLISHED";
    shop.themes.get(MAIN_ID)!.role = "MAIN";
  });

  it("published during a job poll: same outcome, polling stops", async () => {
    const runId = await startRun(["f-other"]);
    const copyId = await readyCopy(runId);
    shop.jobPollsUntilDone = 100;
    let polls = 0;
    shop.overrides.CleanCopyTheme = (v) => {
      // The role read before the 3rd job poll sees the copy live.
      if (String(v.id) === copyId && shop.count("CleanCopyUpsert") === 1 && ++polls === 3) {
        shop.themes.get(copyId)!.role = "MAIN";
      }
      return undefined;
    };
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "COPY_PUBLISHED_DURING_WRITE",
    });
    expect(shop.count("CleanCopyJob")).toBe(2);
    expect(runOf(runId).doNotPublish).toBe(true);
    shop.themes.get(copyId)!.role = "UNPUBLISHED";
  });
});

describe("M-e: userErrors come with a job; we still wait for it (probe P3)", () => {
  it("one file rejected, the other applied by the job: per-file outcomes from the post-read", async () => {
    const runId = await startRun(["f-script-1", "f-other"]);
    await readyCopy(runId);
    shop.jobPollsUntilDone = 2;
    shop.upsertRejects.add("snippets/other.liquid");
    shop.upsertUserErrors = [
      { code: "INVALID", filename: "snippets/other.liquid", message: "Liquid syntax error" },
    ];
    await writeCleanCopy(admin, runId, noSleep);
    expect(shop.count("CleanCopyJob")).toBe(2);
    expect(itemsOf(runId)["f-script-1"].status).toBe("removed");
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "UPSERT_FAILED",
    });
    expect(runOf(runId).doNotPublish).toBe(false);
  });
});

describe("M-f: JOB_TIMEOUT sets doNotPublish (the copy may still change)", () => {
  it("job never finishes, file unchanged so far: JOB_TIMEOUT and doNotPublish", async () => {
    const runId = await startRun(["f-other"]);
    await readyCopy(runId);
    shop.jobPollsUntilDone = 1000;
    shop.upsertRejects.add("snippets/other.liquid"); // not applied yet
    await writeCleanCopy(admin, runId, { jobPollAttempts: 2, sleep: async () => {} });
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "JOB_TIMEOUT",
    });
    expect(runOf(runId).doNotPublish).toBe(true);
  });
});

describe("sec 7: a run failed mid-write is never written (probe O5)", () => {
  it("run marked failed STALE after the pre-read: no upsert", async () => {
    const runId = await startRun();
    await readyCopy(runId);
    let n = 0;
    shop.overrides.CleanCopyFiles = () => {
      if (n++ === 0) Object.assign(runOf(runId), { status: "failed", failureReason: "STALE" });
      return undefined;
    };
    expect(await writeCleanCopy(admin, runId, noSleep)).toEqual({ skipped: true });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
    expect(runOf(runId).failureReason).toBe("STALE");
    // Item writes are no-ops on an inactive run (M-j): nothing recorded.
    expect(Object.values(itemsOf(runId)).every((i) => i.postMd5 === null)).toBe(true);
  });
});

describe("sec 8: only plain machine codes leave the adapter (probe O6)", () => {
  it("a GraphQL error code that echoes the body never reaches logs, errors or rows", async () => {
    const runId = await startRun();
    shop.overrides.CleanCopyUpsert = (v) => ({
      errors: [
        { message: `bad value ${JSON.stringify(v)}`, extensions: { code: `X${BODY_MARKER}` } },
      ],
    });
    await readyCopy(runId);
    const err = await writeCleanCopy(admin, runId, noSleep).catch((e: Error) => e);
    const all =
      JSON.stringify(holder.logs) +
      String((err as Error).message) +
      String((err as Error).stack) +
      JSON.stringify(fake.state.fixRuns) +
      JSON.stringify(fake.state.fixItems);
    expect(all).not.toContain(BODY_MARKER);
    expect((err as Error).message).toContain("UNKNOWN");
  });

  it("safeCode allows only [A-Z0-9_]{1,64}", () => {
    expect(safeCode("THROTTLED")).toBe("THROTTLED");
    expect(safeCode("A".repeat(65))).toBe("UNKNOWN");
    expect(safeCode("bad code")).toBe("UNKNOWN");
    expect(safeCode(`X<script>`)).toBe("UNKNOWN");
    expect(safeCode(42)).toBe("UNKNOWN");
  });
});

describe("logic 11: the plan is re-checked inside the worker", () => {
  it("a shop downgraded mid-run is stopped NOT_PROFESSIONAL before duplicating", async () => {
    const runId = await startRun();
    fake.state.shops[0].plan = "Standard";
    await expect(ensureCopyTheme(admin, runId)).rejects.toMatchObject({
      reason: "NOT_PROFESSIONAL",
    });
    expect(shop.count("CleanCopyDuplicate")).toBe(0);
  });

  it("and before writing", async () => {
    const runId = await startRun();
    await readyCopy(runId);
    fake.state.shops[0].plan = "free";
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "NOT_PROFESSIONAL",
    });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "NOT_PROFESSIONAL" });
  });
});

describe("M-k: two apps selected, only one confirmed", () => {
  it("the unconfirmed app's findings are APP_NOT_CONFIRMED, the other app's are not refused", async () => {
    fake.state.findings.push(
      finding("f-loox", "snippets/other.liquid", "GHOST_SCRIPT", SCRIPT_TAG, 0, {
        appName: "Loox",
      }),
    );
    const res = await preflightCleanCopy(
      pf({ findingIds: ["f-script-1", "f-loox"], confirmedApps: ["Ghost App"] }),
    );
    expect(res).toEqual({
      ok: false,
      reason: "FINDINGS_REFUSED",
      findings: [{ findingId: "f-loox", reason: "APP_NOT_CONFIRMED" }],
    });
  });
});

describe("logic 15: ignore rules are the shared isFindingIgnored", () => {
  it("an app-scope ignore refuses the app's findings", async () => {
    holder.ignores = { fingerprints: new Set(), appNames: new Set(["Ghost App"]) };
    const res = await preflightCleanCopy(pf({ findingIds: ["f-other"] }));
    expect(res).toMatchObject({ findings: [{ findingId: "f-other", reason: "IGNORED" }] });
  });
});

describe("M-i: one shared freshness check", () => {
  const scan = () => fake.state.scans[0] as never;

  it("ok returns MAIN", async () => {
    const res = await checkCleanCopyFreshness({
      shopId: SHOP_ID,
      lastThemePublishAt: null,
      scan: scan(),
      admin,
    });
    expect(res).toMatchObject({ ok: true, main: { id: MAIN_ID } });
  });

  it("a newer successful scan of the theme makes it stale", async () => {
    fake.state.scans.push({
      ...fake.state.scans[0],
      id: "scan-2",
      createdAt: new Date("2026-11-10T11:30:00Z"),
    });
    expect(
      await checkCleanCopyFreshness({
        shopId: SHOP_ID,
        lastThemePublishAt: null,
        scan: scan(),
        admin,
      }),
    ).toEqual({ ok: false, reason: "SCAN_STALE" });
  });
});

describe("M-j: STALE sweep fails the lost run's pending items (probe P2)", () => {
  it("items become failed STALE, and the new run is created", async () => {
    const old = await startRun(["f-other"]);
    runOf(old).updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect((await requestCleanCopy(pf({ findingIds: ["f-other"] }))).ok).toBe(true);
    expect(runOf(old)).toMatchObject({ status: "failed", failureReason: "STALE" });
    expect(Object.values(itemsOf(old)).map((i) => [i.status, i.reasonCode])).toEqual([
      ["failed", "STALE"],
    ]);
  });

  it("finalize after a stale sweep changes nothing", async () => {
    const old = await startRun(["f-other"]);
    runOf(old).updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await requestCleanCopy(pf({ findingIds: ["f-other"] }));
    expect(await finalizeFixRun(old)).toBeNull();
  });
});

describe("probe O7: adopting a same-named theme never edits a file that differs from the scan", () => {
  it("only files matching the scan are written", async () => {
    const runId = await startRun();
    const { copyThemeNameFor } = await import("../../app/services/clean-copy.server");
    const name = copyThemeNameFor("Dawn", runId);
    const otherId = "gid://shopify/OnlineStoreTheme/77";
    shop.themes.set(otherId, {
      id: otherId,
      name,
      role: "UNPUBLISHED",
      processing: false,
      processingFailed: false,
      updatedAt: "2026-11-10T12:00:00Z",
      files: new Map(
        Object.entries({ ...THEME_FILES, "layout/theme.liquid": "merchant's own different theme" }),
      ),
    });
    await readyCopy(runId);
    await writeCleanCopy(admin, runId, noSleep);
    expect(shop.themes.get(otherId)!.files.get("layout/theme.liquid")).toBe(
      "merchant's own different theme",
    );
    expect(itemsOf(runId)["f-script-1"].reasonCode).toBe("FILE_CHANGED");
  });
});

// ---------------------------------------------------------------------------
// Audit round 2 (gc-tib.14, gc-tib.16)
// ---------------------------------------------------------------------------

const denied = () => ({
  errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }],
});

describe("r2 gc-tib.14: only a MAIN copy counts as published", () => {
  it("copy deleted after the upsert: COPY_MISSING, never COPY_PUBLISHED_DURING_WRITE", async () => {
    const runId = await startRun(["f-other"]);
    const copyId = await readyCopy(runId);
    shop.overrides.CleanCopyUpsert = () => {
      shop.themes.delete(copyId);
      return undefined;
    };
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "COPY_MISSING",
    });
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "COPY_MISSING" });
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "COPY_MISSING",
    });
  });

  it("copy deleted during a job poll: COPY_MISSING, polling stops", async () => {
    const runId = await startRun(["f-other"]);
    const copyId = await readyCopy(runId);
    shop.jobPollsUntilDone = 100;
    shop.onJobPoll = () => {
      if (shop.count("CleanCopyJob") === 2) shop.themes.delete(copyId);
    };
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "COPY_MISSING",
    });
    expect(shop.count("CleanCopyJob")).toBe(2);
  });

  it("copy moved to another role: COPY_NOT_UNPUBLISHED and doNotPublish", async () => {
    const runId = await startRun(["f-other"]);
    const copyId = await readyCopy(runId);
    shop.overrides.CleanCopyUpsert = () => {
      shop.themes.get(copyId)!.role = "DEVELOPMENT";
      return undefined;
    };
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "COPY_NOT_UNPUBLISHED",
    });
    expect(runOf(runId)).toMatchObject({
      failureReason: "COPY_NOT_UNPUBLISHED",
      doNotPublish: true,
    });
  });

  it("a transient role read retries (throws), the run stays active", async () => {
    const runId = await startRun(["f-other"]);
    const copyId = await readyCopy(runId);
    shop.overrides.CleanCopyTheme = (v) =>
      String(v.id) === copyId && shop.count("CleanCopyUpsert") === 1
        ? new Error("THROTTLED")
        : undefined;
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.not.toHaveProperty("reason");
    expect(runOf(runId).status).toBe("writing");
  });
});

describe("r2 gc-tib.16: a failure after a landed write flags doNotPublish", () => {
  it("ACCESS_DENIED on the post-read after the upsert landed", async () => {
    const runId = await startRun(["f-other"]);
    await readyCopy(runId);
    shop.overrides.CleanCopyFiles = () =>
      shop.count("CleanCopyUpsert") === 1 ? denied() : undefined;
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "ACCESS_DENIED",
    });
    expect(runOf(runId)).toMatchObject({
      status: "failed",
      failureReason: "ACCESS_DENIED",
      doNotPublish: true,
    });
  });

  it("mixed ACCESS_DENIED userErrors on the upsert (other files may have landed)", async () => {
    const runId = await startRun(["f-script-1", "f-other"]);
    await readyCopy(runId);
    shop.upsertUserErrors = [
      { code: "ACCESS_DENIED", filename: "snippets/other.liquid", message: "x" },
    ];
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "ACCESS_DENIED",
    });
    expect(runOf(runId).doNotPublish).toBe(true);
  });

  it("ACCESS_DENIED before any write: no doNotPublish", async () => {
    const runId = await startRun(["f-other"]);
    await readyCopy(runId);
    shop.overrides.CleanCopyFiles = () => denied();
    await expect(writeCleanCopy(admin, runId, noSleep)).rejects.toMatchObject({
      reason: "ACCESS_DENIED",
    });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
    expect(runOf(runId)).toMatchObject({ failureReason: "ACCESS_DENIED", doNotPublish: false });
  });
});
