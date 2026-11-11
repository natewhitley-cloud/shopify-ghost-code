/**
 * Tests for inngest/functions/clean-copy.ts (gc-tib slice 4).
 *
 * The handler runs against the in-memory Prisma fake and the FakeShopify
 * server behind the real adapter. An Inngest retry is simulated by running
 * the handler again from the top: the mock step does not memoize, so every
 * step must be idempotent on its own (a stronger check than real replay).
 */
import { NonRetriableError } from "inngest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const holder = vi.hoisted(() => ({
  fake: null as unknown as { db: unknown },
  shop: null as unknown,
  manifest: null as unknown,
  send: vi.fn(),
  createFunction: vi.fn((config: unknown, trigger: unknown, handler: unknown) => ({
    fn: handler,
    config,
    trigger,
  })),
}));
vi.mock("../../app/db.server", () => ({
  get default() {
    return holder.fake.db;
  },
}));
vi.mock("../../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn(async () => ({ admin: holder.shop })) },
}));
vi.mock("../../app/models/scan-manifest.server", () => ({
  getScanManifest: vi.fn(async () => holder.manifest),
}));
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(async () => ({ fingerprints: new Set(), appNames: new Set() })),
}));
vi.mock("../../inngest/client", () => ({
  inngest: { send: holder.send, createFunction: holder.createFunction },
}));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createCleanCopyAdmin } from "../../app/services/clean-copy-admin.server";
import { requestCleanCopy } from "../../app/services/clean-copy.server";
import { cleanCopy, COPY_POLL_WAITS } from "../../inngest/functions/clean-copy";
import { createMockInngestEvent, createMockInngestStep, getInngestHandler } from "../mocks/inngest";
import {
  BODY_MARKER,
  createFakeDb,
  DEFAULT_FINDINGS,
  FakeShopify,
  type FakeDb,
  LINK_TAG,
  MAIN_ID,
  manifestFor,
  RENDER_TAG,
  SCAN_ID,
  SCRIPT_TAG,
  seed,
  SHOP_ID,
  THEME_FILES,
} from "../services/clean-copy.fakes";

const registration = cleanCopy as unknown as {
  config: {
    id: string;
    retries: number;
    concurrency: unknown;
    onFailure: (ctx: { event: unknown; error: unknown }) => Promise<void>;
  };
  trigger: unknown;
};

let fake: FakeDb;
let shop: FakeShopify;

beforeEach(() => {
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  fake = createFakeDb();
  holder.fake = fake;
  holder.manifest = manifestFor();
  holder.send.mockReset().mockResolvedValue(undefined);
  seed(fake);
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  holder.shop = shop;
});

afterEach(() => {
  // INVARIANT: MAIN is never a write target and never changes.
  expect(shop.mutationTargets()).not.toContain(MAIN_ID);
  expect(Object.fromEntries(shop.themes.get(MAIN_ID)!.files)).toEqual(THEME_FILES);
  vi.unstubAllEnvs();
});

async function createRun(findingIds = DEFAULT_FINDINGS.map((f) => f.id)) {
  const res = await requestCleanCopy({
    shopId: SHOP_ID,
    scanId: SCAN_ID,
    findingIds,
    confirmedApps: ["Ghost App"],
    grantedScopes: ["write_themes"],
    admin: createCleanCopyAdmin(shop),
  });
  if (!res.ok) throw new Error(`request refused: ${res.reason}`);
  shop.calls = []; // only the worker's calls from here on
  return res.runId;
}

type StepLog = { name: string; result: unknown }[];

async function run(fixRunId: string, shopId = SHOP_ID) {
  const step = createMockInngestStep();
  const log: StepLog = [];
  step.run.mockImplementation(async (name: string, fn: () => unknown) => {
    const result = await fn();
    log.push({ name, result });
    return result;
  });
  const event = createMockInngestEvent("clean-copy/requested", { shopId, fixRunId });
  const result = await getInngestHandler(cleanCopy)({ event, step });
  return { result, step, log, event };
}

const runOf = (id: string) => fake.state.fixRuns.find((r) => r.id === id)!;
const itemStatuses = (id: string) =>
  fake.state.fixItems.filter((i) => i.fixRunId === id).map((i) => i.status);

describe("registration", () => {
  it("listens to clean-copy/requested with per-shop and global concurrency 1", () => {
    expect(registration.trigger).toEqual({ event: "clean-copy/requested" });
    expect(registration.config).toMatchObject({
      id: "clean-copy",
      retries: 3,
      concurrency: [{ key: "event.data.shopId", limit: 1 }, { limit: 1 }],
    });
    expect(typeof registration.config.onFailure).toBe("function");
  });
});

describe("lifecycle", () => {
  it("first run: full success -> completed, every item removed, copy cleaned", async () => {
    const runId = await createRun();
    shop.processingChecks = 2;
    const { result, step, log } = await run(runId);
    expect(result).toEqual({ fixRunId: runId, outcome: "completed" });
    expect(runOf(runId)).toMatchObject({ status: "completed", doNotPublish: false });
    expect(itemStatuses(runId).every((s) => s === "removed")).toBe(true);
    const copyId = runOf(runId).copyThemeId as string;
    expect(shop.themes.get(copyId)!.role).toBe("UNPUBLISHED");
    const theme = shop.themes.get(copyId)!.files;
    expect(theme.get("layout/theme.liquid")).not.toContain(SCRIPT_TAG);
    expect(theme.get("sections/header.liquid")).not.toContain(LINK_TAG);
    expect(theme.get("sections/header.liquid")).not.toContain(RENDER_TAG);
    expect(log.map((l) => l.name)).toEqual([
      "load",
      "duplicate",
      "check-copy-0",
      "check-copy-1",
      "check-copy-2",
      "write",
      "finalize",
    ]);
    expect(step.sleep).toHaveBeenCalledWith("wait-copy-0", COPY_POLL_WAITS[0]);
  });

  it("worst case stays under 20 Inngest steps (ready on the last check: 17)", async () => {
    const runId = await createRun();
    shop.processingChecks = COPY_POLL_WAITS.length;
    const { result, step, log } = await run(runId);
    expect(result).toEqual({ fixRunId: runId, outcome: "completed" });
    expect(log.length + step.sleep.mock.calls.length).toBe(17);
  });

  it("copy never finishes processing -> DUPLICATE_TIMEOUT after the last check, nothing written", async () => {
    const runId = await createRun();
    shop.processingChecks = 1000;
    const { result, step, log } = await run(runId);
    expect(result).toEqual({ fixRunId: runId, outcome: "DUPLICATE_TIMEOUT" });
    expect(log.length + step.sleep.mock.calls.length).toBeLessThan(20);
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("partial: some items removed -> partial", async () => {
    const runId = await createRun(["f-script-1", "f-other"]);
    fake.state.fixItems.find((i) => i.findingId === "f-other")!.spanSha256 = "bad";
    const { result } = await run(runId);
    expect(result).toMatchObject({ outcome: "partial" });
  });

  it("none removed -> failed NOTHING_REMOVED", async () => {
    const runId = await createRun(["f-other"]);
    fake.state.fixItems[0].spanSha256 = "bad";
    const { result } = await run(runId);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(runOf(runId).failureReason).toBe("NOTHING_REMOVED");
  });

  it("flag off -> run failed FLAG_OFF before any Admin call", async () => {
    const runId = await createRun();
    vi.stubEnv("CLEAN_COPY_ENABLED", "false");
    const { result } = await run(runId);
    expect(result).toEqual({ fixRunId: runId, outcome: "flag_off" });
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "FLAG_OFF" });
    expect(shop.calls).toHaveLength(0);
  });

  it("event for another shop's run is a no-op", async () => {
    const runId = await createRun();
    const { result } = await run(runId, "shop-evil");
    expect(result).toMatchObject({ outcome: "not_found" });
    expect(shop.calls).toHaveLength(0);
    expect(runOf(runId).status).toBe("pending");
  });

  it("a business failure ends the run without throwing (no Inngest retry)", async () => {
    const runId = await createRun();
    shop.overrides.CleanCopyDuplicate = () => ({
      data: {
        themeDuplicate: { newTheme: null, userErrors: [{ code: "THEME_LIMIT", message: "x" }] },
      },
    });
    const { result } = await run(runId);
    expect(result).toEqual({ fixRunId: runId, outcome: "DUPLICATE_FAILED" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("ACCESS_DENIED -> run failed ACCESS_DENIED and NonRetriableError (no retries)", async () => {
    const runId = await createRun();
    shop.overrides.CleanCopyDuplicate = () => ({
      errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }],
    });
    const err = await run(runId).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetriableError);
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "ACCESS_DENIED" });
    // onFailure afterwards keeps the reason
    await registration.config.onFailure({
      event: { data: { event: { data: { shopId: SHOP_ID, fixRunId: runId } } } },
      error: err,
    });
    expect(runOf(runId).failureReason).toBe("ACCESS_DENIED");
  });

  it("second run while one is active is refused at request time", async () => {
    await createRun();
    const second = await requestCleanCopy({
      shopId: SHOP_ID,
      scanId: SCAN_ID,
      findingIds: ["f-other"],
      confirmedApps: ["Ghost App"],
      grantedScopes: ["write_themes"],
      admin: createCleanCopyAdmin(shop),
    });
    expect(second).toMatchObject({ ok: false, reason: "RUN_ACTIVE" });
  });

  it("a later run only sees its own items (an old run's removals never count)", async () => {
    const first = await createRun(["f-other"]);
    await run(first);
    const second = await createRun(["f-script-1"]);
    fake.state.fixItems.find((i) => i.fixRunId === second)!.spanSha256 = "bad";
    const { result } = await run(second);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(runOf(first).status).toBe("completed");
  });
});

describe("Inngest retry after a crash at each boundary", () => {
  it("after create (event redelivered before any step): completes normally", async () => {
    const runId = await createRun();
    await run(runId);
    expect(runOf(runId).status).toBe("completed");
    expect(shop.count("CleanCopyDuplicate")).toBe(1);
  });

  it("after the duplicate mutation, before the DB write: adopts the copy, never duplicates twice", async () => {
    const runId = await createRun();
    fake.state.failNextCopyThemeWrite = true;
    await expect(run(runId)).rejects.toThrow(/simulated crash/);
    const { result } = await run(runId);
    expect(result).toMatchObject({ outcome: "completed" });
    expect(shop.count("CleanCopyDuplicate")).toBe(1);
    expect([...shop.themes.values()].filter((t) => t.role === "UNPUBLISHED")).toHaveLength(1);
  });

  it("after the upsert, before the DB update: marks removed via expected md5, never writes twice", async () => {
    const runId = await createRun();
    let reads = 0;
    shop.overrides.CleanCopyFiles = () =>
      ++reads === 2 ? new Error("crash after upsert") : undefined;
    await expect(run(runId)).rejects.toThrow();
    shop.overrides = {};
    const { result } = await run(runId);
    expect(result).toMatchObject({ outcome: "completed" });
    expect(shop.count("CleanCopyUpsert")).toBe(1);
    expect(shop.count("CleanCopyDuplicate")).toBe(1);
  });

  it("after finalize: a redelivery is a no-op (no Admin calls)", async () => {
    const runId = await createRun();
    await run(runId);
    shop.calls = [];
    const { result } = await run(runId);
    expect(result).toMatchObject({ outcome: "not_active" });
    expect(shop.calls).toHaveLength(0);
  });

  it("onFailure maps a deserialized ACCESS_DENIED error (plain object) to ACCESS_DENIED", async () => {
    const runId = await createRun();
    await registration.config.onFailure({
      event: { data: { event: { data: { shopId: SHOP_ID, fixRunId: runId } } } },
      error: { name: "NonRetriableError", message: "clean copy: ACCESS_DENIED (x)" },
    });
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "ACCESS_DENIED" });
  });

  it("onFailure (retries exhausted) fails a still-active run and its pending items", async () => {
    const runId = await createRun();
    await registration.config.onFailure({
      event: { data: { event: { data: { shopId: SHOP_ID, fixRunId: runId } } } },
      error: new Error("boom"),
    });
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "INTERNAL_ERROR" });
    expect(itemStatuses(runId).every((s) => s === "failed")).toBe(true);
  });
});

describe("privacy: theme content never crosses an Inngest boundary", () => {
  const leaks = (value: unknown) => {
    const text = JSON.stringify(value) ?? "";
    return [BODY_MARKER, SCRIPT_TAG, LINK_TAG, RENDER_TAG, "<html>"].filter((s) =>
      text.includes(s),
    );
  };

  it("happy path: no step return value or event payload contains file content or span text", async () => {
    const runId = await createRun();
    shop.processingChecks = 1;
    const { log, event, result } = await run(runId);
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log)
      expect({ step: entry.name, leaks: leaks(entry.result) }).toEqual({
        step: entry.name,
        leaks: [],
      });
    expect(leaks(event)).toEqual([]);
    expect(leaks(holder.send.mock.calls)).toEqual([]);
    expect(leaks(result)).toEqual([]);
  });

  it("error paths: thrown errors carry no content, even when Shopify echoes it", async () => {
    const runId = await createRun();
    // Transient upsert error whose message echoes the body.
    shop.overrides.CleanCopyUpsert = () => ({
      errors: [
        { message: `invalid value ${BODY_MARKER} ${SCRIPT_TAG}`, extensions: { code: "INTERNAL" } },
      ],
    });
    const err = await run(runId).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(leaks({ message: err.message, stack: err.stack })).toEqual([]);
  });
});
