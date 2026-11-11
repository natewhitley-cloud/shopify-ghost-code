/**
 * Audit r7 (logic) M1/M2: fix-time failure isolation across files. A throw
 * while checking one file rolls back only that file's decisions, never an
 * earlier file's decisions or write; every file failing ends the run
 * failed NOTHING_REMOVED with nothing written. Same boundaries as
 * clean-copy-fix-outcomes.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  fake: null as unknown as { db: unknown },
  manifest: null as unknown,
  ignores: { fingerprints: new Set<string>(), appNames: new Set<string>() },
  send: vi.fn(),
  guardMode: "real" as string,
  plan: new Map<number, "throw" | "refuse">(),
  spliceMode: "real" as "real" | "structure-theme" | "throw-theme",
  warn: vi.fn(),
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
  logger: { info: vi.fn(), warn: holder.warn, error: vi.fn() },
}));
/** The guard throws for layout/theme.liquid (the only file with <title>). */
vi.mock("../../app/lib/removal-span", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/removal-span");
  return {
    ...real,
    removalSpanFor: (...args: Parameters<typeof real.removalSpanFor>) => {
      if (holder.guardMode === "throw-theme" && args[1].includes("<title>")) {
        throw new Error("guard boom");
      }
      if (holder.guardMode === "throw-all") throw new Error("guard boom");
      if (holder.guardMode === "plan") {
        const p = holder.plan.get(args[2] as number);
        if (p === "throw") throw new Error("guard boom");
        if (p === "refuse") return { ok: false, reason: "NOT_AT_ELEMENT" } as never;
      }
      return real.removalSpanFor(...args);
    },
  };
});
/** The splice re-check fails (or the splice throws) for layout/theme.liquid. */
vi.mock("../../app/lib/theme-splice", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/theme-splice");
  return {
    ...real,
    spliceSpans: (content: string, spans: Array<{ start: number; end: number }>) => {
      if (holder.spliceMode === "throw-theme" && content.includes("<title>")) {
        throw new Error("splice boom");
      }
      return holder.spliceMode === "structure-theme" && content.includes("<title>")
        ? {
            content,
            removed: [],
            refused: spans.map((s) => ({ span: s, reason: "STRUCTURE_CHANGED" as const })),
          }
        : real.spliceSpans(content, spans);
    },
  };
});

import {
  createFakeDb,
  FakeShopify,
  type FakeDb,
  MAIN_ID,
  manifestFor,
  SCAN_ID,
  seed,
  SHOP_ID,
  spanOf,
  THEME_FILES,
} from "./clean-copy.fakes";
import { finalizeFixRun } from "../../app/models/fix-run.server";
import { createCleanCopyAdmin } from "../../app/services/clean-copy-admin.server";
import {
  checkCopyReady,
  ensureCopyTheme,
  requestCleanCopy,
  writeCleanCopy,
} from "../../app/services/clean-copy.server";

let fake: FakeDb;
let shop: FakeShopify;
let admin: ReturnType<typeof createCleanCopyAdmin>;

beforeEach(() => {
  holder.plan = new Map();
  holder.warn.mockReset();
  IDS = ["f-script-1", "f-other"];
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  holder.guardMode = "real";
  holder.spliceMode = "real";
  fake = createFakeDb();
  holder.fake = fake;
  holder.manifest = manifestFor();
  holder.send.mockReset().mockResolvedValue(undefined);
  seed(fake);
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  admin = createCleanCopyAdmin(shop);
});
afterEach(() => vi.unstubAllEnvs());

/** f-script-1 lives in layout/theme.liquid, f-other in snippets/other.liquid. */
let IDS = ["f-script-1", "f-other"];

async function startRun() {
  const res = await requestCleanCopy({
    shopId: SHOP_ID,
    scanId: SCAN_ID,
    findingIds: IDS,
    confirmedApps: ["Ghost App"],
    grantedScopes: ["read_themes", "write_themes"],
    admin,
  });
  if (!res.ok) throw new Error(res.reason);
  const dup = (await ensureCopyTheme(admin, res.runId)) as { copyThemeId: string };
  while ((await checkCopyReady(admin, res.runId, dup.copyThemeId, false)) === "processing");
  return { runId: res.runId, copyThemeId: dup.copyThemeId };
}

async function runToEnd() {
  const { runId, copyThemeId } = await startRun();
  await writeCleanCopy(admin, runId, { sleep: async () => {} });
  const fin = await finalizeFixRun(runId);
  const run = fake.state.fixRuns.find((x) => x.id === runId)!;
  const items = Object.fromEntries(
    fake.state.fixItems.filter((i) => i.fixRunId === runId).map((i) => [i.findingId, i]),
  );
  return { fin, run, items, copy: shop.themes.get(copyThemeId)! };
}

const WIDGET = '<script src="https://cdn.ghostapp.example/widget.js"></script>';
const CHECK_FAILED = { status: "skipped", reasonCode: "VALIDATION_FAILED:CHECK_FAILED" };

describe("fix-time failure isolation across files (audit r7)", () => {
  it("every file throws: all CHECK_FAILED, run failed NOTHING_REMOVED, nothing written, publishable flag off", async () => {
    holder.guardMode = "throw-all";
    const o = await runToEnd();
    expect(o.items["f-script-1"]).toMatchObject(CHECK_FAILED);
    expect(o.items["f-other"]).toMatchObject(CHECK_FAILED);
    expect(o.fin).toMatchObject({ status: "failed", failureReason: "NOTHING_REMOVED" });
    expect(o.run.doNotPublish).toBe(false);
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("an item already decided in the same file keeps its own reason when a later item throws (gc-wkpc L3)", async () => {
    IDS = ["f-script-1", "f-script-2", "f-other"];
    holder.guardMode = "plan";
    holder.plan.set(spanOf("layout/theme.liquid", WIDGET, 0).spanStart, "refuse");
    holder.plan.set(spanOf("layout/theme.liquid", WIDGET, 1).spanStart, "throw");
    const o = await runToEnd();
    expect(o.items["f-script-1"]).toMatchObject({ status: "skipped", reasonCode: "SPAN_MISMATCH" });
    expect(o.items["f-script-2"]).toMatchObject(CHECK_FAILED);
    expect(o.items["f-other"].status).toBe("removed");
    expect(o.fin?.status).toBe("partial");
    expect(holder.warn).toHaveBeenCalledWith(
      "clean-copy-file-check-failed",
      expect.objectContaining({ filename: "layout/theme.liquid", cause: "Error" }),
    );
  });

  it("an earlier file's refusal survives a later file's throw", async () => {
    IDS = ["f-other", "f-link", "f-script-1"];
    holder.guardMode = "plan";
    holder.plan.set(
      spanOf(
        "sections/header.liquid",
        '<link rel="stylesheet" href="https://cdn.ghostapp.example/w.css">',
      ).spanStart,
      "refuse",
    );
    holder.plan.set(spanOf("layout/theme.liquid", WIDGET, 0).spanStart, "throw");
    const o = await runToEnd();
    expect(o.items["f-link"]).toMatchObject({ status: "skipped", reasonCode: "SPAN_MISMATCH" });
    expect(o.items["f-script-1"]).toMatchObject(CHECK_FAILED);
    expect(o.items["f-other"].status).toBe("removed");
    expect(o.fin?.status).toBe("partial");
  });

  it("a later file's throw keeps an earlier file's write", async () => {
    holder.guardMode = "plan";
    const theme = spanOf("layout/theme.liquid", WIDGET).spanStart;
    const other = spanOf("snippets/other.liquid", WIDGET).spanStart;
    expect(theme).not.toBe(other);
    holder.plan.set(other, "throw");
    const o = await runToEnd();
    expect(o.items["f-script-1"].status).toBe("removed");
    expect(o.items["f-other"]).toMatchObject(CHECK_FAILED);
    expect(o.fin?.status).toBe("partial");
    expect(o.run.doNotPublish).toBe(false);
    expect(shop.count("CleanCopyUpsert")).toBe(1);
  });
});
