/**
 * Tests for app/services/clean-copy.server.ts (gc-tib slice 4).
 *
 * Boundaries mocked: Prisma (in-memory fake), the manifest + ignore models,
 * the Inngest client. Shopify is the FakeShopify GraphQL server behind the
 * REAL adapter, so the adapter's write guard is exercised in every test.
 *
 * INVARIANT (afterEach, every test): no upsert ever targets MAIN, and MAIN's
 * files are byte-identical to the fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  BODY_MARKER,
  createFakeDb,
  DEFAULT_FINDINGS,
  FakeShopify,
  type FakeDb,
  finding,
  LINK_TAG,
  MAIN_ID,
  manifestFor,
  md5,
  RENDER_TAG,
  SCAN_ID,
  SCRIPT_TAG,
  seed,
  sha256,
  SHOP_ID,
  THEME_FILES,
} from "./clean-copy.fakes";
import { createCleanCopyAdmin } from "../../app/services/clean-copy-admin.server";
import {
  checkCopyReady,
  CleanCopyFailure,
  copyThemeNameFor,
  ensureCopyTheme,
  preflightCleanCopy,
  requestCleanCopy,
  writeCleanCopy,
  type PreflightInput,
} from "../../app/services/clean-copy.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";

let fake: FakeDb;
let shop: FakeShopify;
let admin: ReturnType<typeof createCleanCopyAdmin>;

beforeEach(() => {
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  fake = createFakeDb();
  holder.fake = fake;
  holder.manifest = manifestFor();
  holder.ignores = { fingerprints: new Set(), appNames: new Set() };
  holder.send.mockReset().mockResolvedValue(undefined);
  seed(fake);
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  admin = createCleanCopyAdmin(shop);
});

afterEach(() => {
  // INVARIANT: MAIN is never a write target, and MAIN is never changed.
  expect(shop.mutationTargets()).not.toContain(MAIN_ID);
  expect(Object.fromEntries(shop.themes.get(MAIN_ID)!.files)).toEqual(THEME_FILES);
  expect(shop.themes.get(MAIN_ID)!.role).toBe("MAIN");
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
  ...over,
});

async function startRun(findingIds: string[] = ALL_IDS) {
  const res = await requestCleanCopy(pf({ findingIds }));
  if (!res.ok) throw new Error(`request refused: ${res.reason}`);
  return res.runId;
}

/** Drive the worker steps like the Inngest function does. */
async function runToWrite(runId: string) {
  const dup = await ensureCopyTheme(admin, runId);
  if (!("copyThemeId" in dup)) throw new Error("no copy");
  while ((await checkCopyReady(admin, runId, dup.copyThemeId, false)) === "processing");
  await writeCleanCopy(admin, runId, { sleep: async () => {} });
  return dup.copyThemeId;
}

const runOf = (id: string) => fake.state.fixRuns.find((r) => r.id === id)!;
const itemsOf = (id: string): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    fake.state.fixItems.filter((i) => i.fixRunId === id).map((i) => [i.findingId, i]),
  );
const copyFile = (copyId: string, f: string) => shop.themes.get(copyId)!.files.get(f)!;

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe("preflightCleanCopy", () => {
  it("ok: returns items with the manifest md5 as preMd5", async () => {
    const res = await preflightCleanCopy(pf());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceThemeId).toBe(MAIN_ID);
    expect(res.items).toHaveLength(5);
    expect(res.items[0]).toMatchObject({
      findingId: "f-script-1",
      findingType: "GHOST_SCRIPT",
      preMd5: md5(THEME_FILES["layout/theme.liquid"]),
    });
  });

  it("flag off -> FLAG_OFF (no Admin call)", async () => {
    vi.stubEnv("CLEAN_COPY_ENABLED", "false");
    expect(await preflightCleanCopy(pf())).toEqual({ ok: false, reason: "FLAG_OFF" });
    expect(shop.calls).toHaveLength(0);
  });

  it("empty selection -> EMPTY_SELECTION", async () => {
    expect(await preflightCleanCopy(pf({ findingIds: [] }))).toEqual({
      ok: false,
      reason: "EMPTY_SELECTION",
    });
  });

  it("more than 500 ids -> TOO_MANY_FINDINGS (no query)", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `f${i}`);
    expect(await preflightCleanCopy(pf({ findingIds: ids }))).toEqual({
      ok: false,
      reason: "TOO_MANY_FINDINGS",
    });
    expect(shop.calls).toHaveLength(0);
  });

  it("more than 50 distinct files -> TOO_MANY_FILES", async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      ...DEFAULT_FINDINGS[4],
      id: `many-${i}`,
      filename: `snippets/s${i}.liquid`,
    }));
    fake.state.findings.push(...many);
    const m = manifestFor() as { entries: unknown[][] };
    m.entries.push(...many.map((f) => [f.filename, "md5", 1, null, null]));
    holder.manifest = m;
    expect(await preflightCleanCopy(pf({ findingIds: many.map((f) => f.id) }))).toEqual({
      ok: false,
      reason: "TOO_MANY_FILES",
    });
  });

  it.each(["free", "Standard"])("plan %s -> NOT_PROFESSIONAL", async (plan) => {
    fake.state.shops[0].plan = plan;
    expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "NOT_PROFESSIONAL" });
  });

  it("write_themes not granted -> SCOPE_MISSING", async () => {
    expect(await preflightCleanCopy(pf({ grantedScopes: ["read_themes"] }))).toMatchObject({
      reason: "SCOPE_MISSING",
    });
  });

  it("scan of another shop -> SCAN_NOT_FOUND", async () => {
    expect(await preflightCleanCopy(pf({ shopId: "shop-x" }))).toMatchObject({
      reason: "SHOP_NOT_FOUND",
    });
    fake.state.shops.push({ id: "shop-2", plan: "Professional", lastThemePublishAt: null });
    expect(await preflightCleanCopy(pf({ shopId: "shop-2" }))).toMatchObject({
      reason: "SCAN_NOT_FOUND",
    });
  });

  describe("stale -> SCAN_STALE", () => {
    it("a newer successful scan of the theme exists", async () => {
      fake.state.scans.push({
        ...fake.state.scans[0],
        id: "scan-2",
        createdAt: new Date("2026-11-10T11:30:00Z"),
      });
      expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "SCAN_STALE" });
    });

    it("the scan did not succeed", async () => {
      fake.state.scans[0].status = "FAILED";
      expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "SCAN_STALE" });
    });

    it("MAIN is now a different theme", async () => {
      shop.themes.get(MAIN_ID)!.role = "UNPUBLISHED";
      shop.themes.set("gid://shopify/OnlineStoreTheme/2", {
        ...shop.themes.get(MAIN_ID)!,
        id: "gid://shopify/OnlineStoreTheme/2",
        role: "MAIN",
        files: new Map(),
      });
      expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "SCAN_STALE" });
      // restore for the afterEach invariant
      shop.themes.delete("gid://shopify/OnlineStoreTheme/2");
      shop.themes.get(MAIN_ID)!.role = "MAIN";
    });

    it("MAIN.updatedAt is after the scan completed", async () => {
      shop.themes.get(MAIN_ID)!.updatedAt = "2026-11-10T11:05:00Z";
      expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "SCAN_STALE" });
    });

    it("a theme was published after the scan (lastThemePublishAt)", async () => {
      fake.state.shops[0].lastThemePublishAt = new Date("2026-11-10T11:10:00Z");
      expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "SCAN_STALE" });
    });
  });

  it("MAIN read ACCESS_DENIED / transient -> ACCESS_DENIED / ADMIN_UNAVAILABLE", async () => {
    shop.overrides.CleanCopyMain = () => ({
      errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }],
    });
    expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "ACCESS_DENIED" });
    shop.overrides.CleanCopyMain = () => new Error("ECONNRESET");
    expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "ADMIN_UNAVAILABLE" });
  });

  it("manifest missing -> MANIFEST_MISSING", async () => {
    holder.manifest = null;
    expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "MANIFEST_MISSING" });
  });

  it("manifest md5 null for an affected file -> MANIFEST_MD5_MISSING for that finding", async () => {
    const m = manifestFor() as { entries: unknown[][] };
    m.entries.find((e) => e[0] === "snippets/other.liquid")![1] = null;
    holder.manifest = m;
    expect(await preflightCleanCopy(pf())).toEqual({
      ok: false,
      reason: "FINDINGS_REFUSED",
      findings: [{ findingId: "f-other", reason: "MANIFEST_MD5_MISSING" }],
    });
  });

  it("embed status not observed on the scan -> EMBED_STATUS_UNKNOWN", async () => {
    fake.state.scans[0].liveAppHooks = null;
    expect(await preflightCleanCopy(pf())).toMatchObject({ reason: "EMBED_STATUS_UNKNOWN" });
  });

  describe("per-finding refusals", () => {
    const refusalFor = async (
      f: ReturnType<typeof finding>,
      over: Partial<PreflightInput> = {},
    ) => {
      fake.state.findings.push(f);
      const res = await preflightCleanCopy(pf({ findingIds: [f.id], ...over }));
      return res.ok ? null : res.findings?.[0]?.reason;
    };

    it("finding not in this scan -> NOT_IN_SCAN", async () => {
      fake.state.findings.push({ ...DEFAULT_FINDINGS[0], id: "f-elsewhere", scanId: "scan-0" });
      const res = await preflightCleanCopy(pf({ findingIds: ["f-elsewhere", "nope"] }));
      expect(res).toEqual({
        ok: false,
        reason: "FINDINGS_REFUSED",
        findings: [
          { findingId: "f-elsewhere", reason: "NOT_IN_SCAN" },
          { findingId: "nope", reason: "NOT_IN_SCAN" },
        ],
      });
    });

    it.each(["MALICIOUS_SCRIPT", "GHOST_APP_EMBED", "ORPHAN_ASSET"])(
      "type %s -> NOT_FIXABLE_TYPE",
      async (type) => {
        const f = {
          ...finding("x", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG),
          findingType: type,
        };
        expect(await refusalFor(f)).toBe("NOT_FIXABLE_TYPE");
      },
    );

    it("no span (legacy scan) -> NO_SPAN", async () => {
      const f = finding("x", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG, 0, {
        spanStart: null,
        spanEnd: null,
        spanSha256: null,
      });
      expect(await refusalFor(f)).toBe("NO_SPAN");
    });

    it.each([
      "assets/app.js.liquid",
      "config/settings_data.json",
      "templates/index.json",
      "locales/en.json",
    ])("path %s -> PATH_NOT_ALLOWED", async (filename) => {
      const f = { ...finding("x", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG), filename };
      expect(await refusalFor(f)).toBe("PATH_NOT_ALLOWED");
    });

    it("ignored instance (fingerprint) or ignored app -> IGNORED", async () => {
      const f = finding("x", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG);
      holder.ignores.fingerprints.add(
        fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber),
      );
      expect(await refusalFor(f)).toBe("IGNORED");
      holder.ignores = { fingerprints: new Set(), appNames: new Set(["Ghost App"]) };
      expect((await preflightCleanCopy(pf({ findingIds: ["f-link"] }))).ok).toBe(false);
    });

    it("app with an enabled app embed -> APP_HAS_LIVE_EMBED (even if confirmed)", async () => {
      const f = finding("x", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG, 0, {
        appName: "Live Embed App",
      });
      expect(await refusalFor(f, { confirmedApps: ["Live Embed App"] })).toBe("APP_HAS_LIVE_EMBED");
    });

    it("app not confirmed uninstalled -> APP_NOT_CONFIRMED", async () => {
      expect(
        ((await preflightCleanCopy(pf({ confirmedApps: [] }))) as { findings: unknown[] }).findings,
      ).toHaveLength(5);
      const f = finding("x", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG);
      expect(await refusalFor(f, { confirmedApps: ["Other"] })).toBe("APP_NOT_CONFIRMED");
    });

    it("no app attributed -> APP_UNKNOWN", async () => {
      const f = finding("x", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG, 0, {
        appName: null,
      });
      expect(await refusalFor(f)).toBe("APP_UNKNOWN");
    });
  });
});

describe("requestCleanCopy", () => {
  it("creates the run + items and sends clean-copy/requested with ids only", async () => {
    const runId = await startRun();
    expect(holder.send).toHaveBeenCalledWith({
      name: "clean-copy/requested",
      data: { shopId: SHOP_ID, fixRunId: runId },
    });
    expect(Object.keys(itemsOf(runId))).toHaveLength(5);
  });

  it("never stores the merchant's uninstall confirmations", async () => {
    const runId = await startRun();
    const stored = JSON.stringify([runOf(runId), ...Object.values(itemsOf(runId))]);
    expect(stored).not.toContain("confirm");
    expect(stored).not.toContain("Ghost App");
  });

  it("second request while one is active -> RUN_ACTIVE", async () => {
    const first = await startRun();
    expect(await requestCleanCopy(pf())).toEqual({
      ok: false,
      reason: "RUN_ACTIVE",
      activeRunId: first,
    });
    expect(holder.send).toHaveBeenCalledTimes(1);
  });

  it("a failed send fails the run so it does not hold the active slot", async () => {
    holder.send.mockRejectedValueOnce(new Error("no event key"));
    expect(await requestCleanCopy(pf())).toEqual({ ok: false, reason: "DISPATCH_FAILED" });
    expect(fake.state.fixRuns[0]).toMatchObject({
      status: "failed",
      failureReason: "DISPATCH_FAILED",
    });
    expect((await requestCleanCopy(pf())).ok).toBe(true);
  });

  it("a refused preflight creates nothing", async () => {
    expect((await requestCleanCopy(pf({ grantedScopes: [] }))).ok).toBe(false);
    expect(fake.state.fixRuns).toHaveLength(0);
    expect(holder.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

describe("duplicate", () => {
  it("ok: duplicates MAIN once under a unique name with the run id, then reports ready", async () => {
    const runId = await startRun();
    const dup = await ensureCopyTheme(admin, runId);
    expect(dup).toHaveProperty("copyThemeId");
    const name = copyThemeNameFor("Dawn", runId);
    expect(name).toContain(runId.slice(-8));
    expect(runOf(runId)).toMatchObject({ status: "duplicating", copyThemeName: name });
    expect(shop.calls.find((c) => c.op === "CleanCopyDuplicate")!.variables).toEqual({
      id: MAIN_ID,
      name,
    });
    // second call: no second duplicate
    await ensureCopyTheme(admin, runId);
    expect(shop.count("CleanCopyDuplicate")).toBe(1);
  });

  it("keeps theme names within 50 chars", () => {
    expect(copyThemeNameFor("x".repeat(80), "run-abcdefgh12345678").length).toBeLessThanOrEqual(50);
    expect(copyThemeNameFor("   ", "run-12345678")).toBe("Theme - clean copy 12345678");
  });

  it("userError -> failed DUPLICATE_FAILED, nothing written", async () => {
    const runId = await startRun();
    shop.overrides.CleanCopyDuplicate = () => ({
      data: {
        themeDuplicate: {
          newTheme: null,
          userErrors: [{ code: "THEME_LIMIT_REACHED", field: null, message: "limit" }],
        },
      },
    });
    await expect(ensureCopyTheme(admin, runId)).rejects.toBeInstanceOf(CleanCopyFailure);
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "DUPLICATE_FAILED" });
    expect(Object.values(itemsOf(runId)).every((i) => i.status === "failed")).toBe(true);
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("processingFailed -> failed DUPLICATE_PROCESSING_FAILED, nothing written", async () => {
    const runId = await startRun();
    shop.duplicateFails = true;
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await expect(checkCopyReady(admin, runId, dup.copyThemeId, false)).rejects.toMatchObject({
      reason: "DUPLICATE_PROCESSING_FAILED",
    });
    expect(runOf(runId).status).toBe("failed");
    expect(await writeCleanCopy(admin, runId)).toEqual({ skipped: true });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("poll timeout (still processing at the final check) -> failed DUPLICATE_TIMEOUT", async () => {
    const runId = await startRun();
    shop.processingChecks = 100;
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    expect(await checkCopyReady(admin, runId, dup.copyThemeId, false)).toBe("processing");
    await expect(checkCopyReady(admin, runId, dup.copyThemeId, true)).rejects.toMatchObject({
      reason: "DUPLICATE_TIMEOUT",
    });
    expect(runOf(runId).failureReason).toBe("DUPLICATE_TIMEOUT");
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("ACCESS_DENIED -> failed ACCESS_DENIED, nothing written", async () => {
    const runId = await startRun();
    shop.overrides.CleanCopyDuplicate = () => ({
      errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }],
    });
    await expect(ensureCopyTheme(admin, runId)).rejects.toMatchObject({ reason: "ACCESS_DENIED" });
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "ACCESS_DENIED" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("transient error throws a plain Error (retry) and leaves the run active", async () => {
    const runId = await startRun();
    shop.overrides.CleanCopyDuplicate = () => new Error("ECONNRESET");
    const err = await ensureCopyTheme(admin, runId).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CleanCopyFailure);
    expect(runOf(runId).status).toBe("duplicating");
  });

  it("MAIN changed since the run was created -> failed SCAN_STALE before duplicating", async () => {
    const runId = await startRun();
    runOf(runId).sourceThemeId = "gid://shopify/OnlineStoreTheme/42";
    await expect(ensureCopyTheme(admin, runId)).rejects.toMatchObject({ reason: "SCAN_STALE" });
    expect(shop.count("CleanCopyDuplicate")).toBe(0);
  });

  it("flag turned off mid-run -> failed FLAG_OFF before any Admin call", async () => {
    const runId = await startRun();
    const before = shop.calls.length; // preflight's MAIN read
    vi.stubEnv("CLEAN_COPY_ENABLED", "");
    await expect(ensureCopyTheme(admin, runId)).rejects.toMatchObject({ reason: "FLAG_OFF" });
    expect(shop.calls).toHaveLength(before);
    await expect(writeCleanCopy(admin, runId)).resolves.toEqual({ skipped: true });
  });
});

// ---------------------------------------------------------------------------
// Per file + run outcomes
// ---------------------------------------------------------------------------

describe("write: per file", () => {
  it("ok: removes exactly the selected spans in the copy and verifies the post md5", async () => {
    const runId = await startRun();
    const copyId = await runToWrite(runId);
    const items = itemsOf(runId);
    expect(Object.values(items).every((i) => i.status === "removed")).toBe(true);
    const theme = copyFile(copyId, "layout/theme.liquid");
    expect(theme).not.toContain(SCRIPT_TAG);
    expect(theme).toContain("<title>{{ shop.name }}</title>");
    const header = copyFile(copyId, "sections/header.liquid");
    expect(header).not.toContain(LINK_TAG);
    expect(header).not.toContain(RENDER_TAG);
    expect(items["f-script-1"].postMd5).toBe(md5(theme));
    expect(shop.count("CleanCopyUpsert")).toBe(1);
    expect(shop.mutationTargets()).toEqual([copyId]);
  });

  it("two identical tags in one file, only one selected: only that one is removed", async () => {
    const runId = await startRun(["f-script-2"]);
    const copyId = await runToWrite(runId);
    const theme = copyFile(copyId, "layout/theme.liquid");
    const original = THEME_FILES["layout/theme.liquid"];
    const second = original.indexOf(SCRIPT_TAG, original.indexOf(SCRIPT_TAG) + 1);
    // the first tag (before <title>) stays; the second (after it) is gone
    expect(theme.split(SCRIPT_TAG)).toHaveLength(2);
    expect(theme.indexOf(SCRIPT_TAG)).toBeLessThan(theme.indexOf("<title>"));
    expect(theme).toBe(
      original.slice(0, original.lastIndexOf("\n", second) + 1) +
        original.slice(original.indexOf("\n", second) + 1),
    );
    expect(itemsOf(runId)["f-script-2"].status).toBe("removed");
  });

  it("file changed between scan and fix -> skipped FILE_CHANGED, file not written", async () => {
    const runId = await startRun(["f-script-1", "f-other"]);
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await checkCopyReady(admin, runId, dup.copyThemeId, false);
    const edited = `${THEME_FILES["layout/theme.liquid"]}<!-- merchant edit -->`;
    shop.themes.get(dup.copyThemeId)!.files.set("layout/theme.liquid", edited);
    await writeCleanCopy(admin, runId, { sleep: async () => {} });
    expect(itemsOf(runId)["f-script-1"]).toMatchObject({
      status: "skipped",
      reasonCode: "FILE_CHANGED",
    });
    expect(itemsOf(runId)["f-other"].status).toBe("removed");
    expect(copyFile(dup.copyThemeId, "layout/theme.liquid")).toBe(edited);
  });

  it("file missing from the copy -> skipped FILE_CHANGED", async () => {
    const runId = await startRun(["f-other"]);
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await checkCopyReady(admin, runId, dup.copyThemeId, false);
    shop.themes.get(dup.copyThemeId)!.files.delete("snippets/other.liquid");
    await writeCleanCopy(admin, runId);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "skipped",
      reasonCode: "FILE_CHANGED",
    });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("Shopify checksum matches the manifest but not md5(utf8(body)) -> CHECKSUM_UNVERIFIABLE", async () => {
    const original = THEME_FILES["snippets/other.liquid"];
    const runId = await startRun(["f-other"]);
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await checkCopyReady(admin, runId, dup.copyThemeId, false);
    // body differs, Shopify still reports the scanned checksum
    shop.themes.get(dup.copyThemeId)!.files.set("snippets/other.liquid", `${original} `);
    shop.checksumOverride.set(`${dup.copyThemeId}:snippets/other.liquid`, md5(original));
    await writeCleanCopy(admin, runId);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "skipped",
      reasonCode: "CHECKSUM_UNVERIFIABLE",
    });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("span hash mismatch -> SPAN_MISMATCH", async () => {
    const runId = await startRun(["f-script-1", "f-other"]);
    fake.state.fixItems.find((i) => i.findingId === "f-script-1")!.spanSha256 = "0".repeat(64);
    await runToWrite(runId);
    expect(itemsOf(runId)["f-script-1"]).toMatchObject({
      status: "skipped",
      reasonCode: "SPAN_MISMATCH",
    });
    expect(itemsOf(runId)["f-other"].status).toBe("removed");
  });

  it("span boundaries differ from what removalSpanFor finds -> SPAN_MISMATCH", async () => {
    // Hash of a shorter slice that is still a real substring: the hash matches,
    // but the element ends later, so the boundaries disagree.
    const f = DEFAULT_FINDINGS[0];
    const content = THEME_FILES[f.filename];
    const shortEnd = (f.spanEnd as number) - "</script>".length;
    fake.state.findings[0] = {
      ...f,
      spanEnd: shortEnd,
      spanSha256: sha256(content.slice(f.spanStart!, shortEnd)),
    };
    const runId = await startRun(["f-script-1"]);
    await runToWrite(runId);
    expect(itemsOf(runId)["f-script-1"]).toMatchObject({
      status: "skipped",
      reasonCode: "SPAN_MISMATCH",
    });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("unknown stored finding type -> NOT_FIXABLE_TYPE", async () => {
    const runId = await startRun(["f-other"]);
    fake.state.fixItems[0].findingType = null;
    await runToWrite(runId);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "skipped",
      reasonCode: "NOT_FIXABLE_TYPE",
    });
  });

  it("splice refusal -> skipped VALIDATION_FAILED with the splice reason", async () => {
    // Same span selected twice through two findings: the splice refuses both.
    fake.state.findings.push({ ...DEFAULT_FINDINGS[4], id: "f-other-dup" });
    const runId = await startRun(["f-other", "f-other-dup"]);
    await runToWrite(runId);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "skipped",
      reasonCode: "VALIDATION_FAILED:OVERLAPPING_SPANS",
    });
    expect(itemsOf(runId)["f-other-dup"].reasonCode).toBe("VALIDATION_FAILED:OVERLAPPING_SPANS");
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("upsert userError -> failed UPSERT_FAILED (file verified unchanged)", async () => {
    const runId = await startRun(["f-other"]);
    shop.overrides.CleanCopyUpsert = () => ({
      data: {
        themeFilesUpsert: {
          job: null,
          upsertedThemeFiles: [],
          userErrors: [
            {
              code: "INVALID",
              field: ["files"],
              filename: "snippets/other.liquid",
              message: "bad",
            },
          ],
        },
      },
    });
    await runToWrite(runId);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "UPSERT_FAILED",
    });
    expect(runOf(runId).doNotPublish).toBe(false);
  });

  it("job never finishes -> failed JOB_TIMEOUT (file unchanged)", async () => {
    const runId = await startRun(["f-other"]);
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await checkCopyReady(admin, runId, dup.copyThemeId, false);
    shop.jobPollsUntilDone = 1000;
    const original = THEME_FILES["snippets/other.liquid"];
    // The job is async: the file has not changed when we stop waiting.
    shop.upsertTransform = () => original;
    await writeCleanCopy(admin, runId, { jobPollAttempts: 3, sleep: async () => {} });
    expect(shop.count("CleanCopyJob")).toBe(3);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "JOB_TIMEOUT",
    });
  });

  it("waits for the job, then post-reads", async () => {
    const runId = await startRun(["f-other"]);
    shop.jobPollsUntilDone = 2;
    await runToWrite(runId);
    expect(shop.count("CleanCopyJob")).toBe(2);
    expect(itemsOf(runId)["f-other"].status).toBe("removed");
  });

  it("post-read differs from the expected md5 -> POST_WRITE_MISMATCH and doNotPublish", async () => {
    const runId = await startRun(["f-other"]);
    shop.upsertTransform = (_f, c) => `${c}\n<!-- injected -->`;
    await runToWrite(runId);
    expect(itemsOf(runId)["f-other"]).toMatchObject({
      status: "failed",
      reasonCode: "POST_WRITE_MISMATCH",
    });
    expect(runOf(runId).doNotPublish).toBe(true);
  });

  it("upsert ACCESS_DENIED -> run failed ACCESS_DENIED", async () => {
    const runId = await startRun(["f-other"]);
    shop.overrides.CleanCopyUpsert = () => ({
      errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }],
    });
    await expect(runToWrite(runId)).rejects.toMatchObject({ reason: "ACCESS_DENIED" });
    expect(runOf(runId)).toMatchObject({ status: "failed", failureReason: "ACCESS_DENIED" });
  });

  it("the copy turned into MAIN (merchant published it) -> adapter refuses, run failed WRITE_REFUSED", async () => {
    const runId = await startRun(["f-other"]);
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await checkCopyReady(admin, runId, dup.copyThemeId, false);
    shop.themes.get(dup.copyThemeId)!.role = "MAIN";
    await expect(writeCleanCopy(admin, runId)).rejects.toMatchObject({ reason: "WRITE_REFUSED" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
    shop.themes.get(dup.copyThemeId)!.role = "UNPUBLISHED";
  });

  it("a run whose copy id equals the source is refused before any write", async () => {
    const runId = await startRun(["f-other"]);
    runOf(runId).copyThemeId = MAIN_ID;
    await expect(writeCleanCopy(admin, runId)).rejects.toMatchObject({ reason: "COPY_IS_SOURCE" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("never sends file content out except in the upsert body", async () => {
    const runId = await startRun();
    await runToWrite(runId);
    const stored = JSON.stringify([fake.state.fixRuns, fake.state.fixItems]);
    expect(stored).not.toContain(BODY_MARKER);
  });
});

describe("crash-retry inside duplicate and write", () => {
  it("crash after the duplicate mutation, before the DB write: retry adopts the copy by name", async () => {
    const runId = await startRun();
    fake.state.failNextCopyThemeWrite = true;
    await expect(ensureCopyTheme(admin, runId)).rejects.toThrow(/simulated crash/);
    expect(runOf(runId).copyThemeId).toBeNull();
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    expect(shop.count("CleanCopyDuplicate")).toBe(1);
    expect(runOf(runId).copyThemeId).toBe(dup.copyThemeId);
  });

  it("crash after the upsert, before items were marked: retry marks them removed, no second write", async () => {
    const runId = await startRun(["f-script-1", "f-other"]);
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await checkCopyReady(admin, runId, dup.copyThemeId, false);
    let postReads = 0;
    shop.overrides.CleanCopyFiles = () => {
      // 1st read = pre-read, 2nd = post-read: crash there.
      if (++postReads === 2) return new Error("network died after upsert");
      return undefined;
    };
    await expect(writeCleanCopy(admin, runId)).rejects.toThrow();
    expect(Object.values(itemsOf(runId)).every((i) => i.status === "pending" && i.postMd5)).toBe(
      true,
    );
    shop.overrides = {};
    await writeCleanCopy(admin, runId);
    expect(shop.count("CleanCopyUpsert")).toBe(1);
    expect(Object.values(itemsOf(runId)).map((i) => i.status)).toEqual(["removed", "removed"]);
  });

  it("expected md5 recorded but the upsert never landed: retry writes normally", async () => {
    const runId = await startRun(["f-other"]);
    const dup = (await ensureCopyTheme(admin, runId)) as { copyThemeId: string };
    await checkCopyReady(admin, runId, dup.copyThemeId, false);
    shop.overrides.CleanCopyUpsert = () => new Error("ECONNRESET");
    await expect(writeCleanCopy(admin, runId)).rejects.toThrow();
    shop.overrides = {};
    await writeCleanCopy(admin, runId);
    expect(itemsOf(runId)["f-other"].status).toBe("removed");
  });
});
