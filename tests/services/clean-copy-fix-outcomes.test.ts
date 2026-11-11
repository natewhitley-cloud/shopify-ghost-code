/**
 * gc-t44r X5 (r5), retargeted after the second parser was removed (r6):
 * fix-time outcomes of a throw while checking one file and of the splice
 * structure re-check, the merchant copy for both, and a shop removed from
 * the allowlist mid-run. Same boundaries as clean-copy.server.test.ts:
 * in-memory Prisma fake, FakeShopify behind the real adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  fake: null as unknown as { db: unknown },
  manifest: null as unknown,
  ignores: { fingerprints: new Set<string>(), appNames: new Set<string>() },
  send: vi.fn(),
  guardMode: "real" as "real" | "throw-theme",
  spliceMode: "real" as "real" | "structure-theme" | "throw-theme",
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
/** The guard throws for layout/theme.liquid (the only file with <title>). */
vi.mock("../../app/lib/removal-span", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/removal-span");
  return {
    ...real,
    removalSpanFor: (...args: Parameters<typeof real.removalSpanFor>) => {
      if (holder.guardMode === "throw-theme" && args[1].includes("<title>")) {
        throw new Error("guard boom");
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
  THEME_FILES,
} from "./clean-copy.fakes";
import { fixItemReasonCopy, runSummary } from "../../app/lib/clean-copy-view";
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
const IDS = ["f-script-1", "f-other"];
const THEME = "layout/theme.liquid";

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

describe("fix-time refusals leave one file alone and write the others", () => {
  it("control: both removed, run completed", async () => {
    const o = await runToEnd();
    expect(o.items["f-script-1"].status).toBe("removed");
    expect(o.items["f-other"].status).toBe("removed");
    expect(o.fin?.status).toBe("completed");
  });

  it.each([
    ["the guard", "guardMode"],
    ["the splice", "spliceMode"],
  ] as const)(
    "a throw in %s while checking one file (audit r6 L3): CHECK_FAILED, other file written, partial",
    async (_label, key) => {
      holder[key] = "throw-theme";
      const o = await runToEnd();
      expect(o.items["f-script-1"]).toMatchObject({
        status: "skipped",
        reasonCode: "VALIDATION_FAILED:CHECK_FAILED",
      });
      expect(o.items["f-other"].status).toBe("removed");
      expect(o.fin?.status).toBe("partial");
      expect(o.run.doNotPublish).toBe(false);
      expect(o.copy.files.get(THEME)).toBe(THEME_FILES[THEME]);
    },
  );

  it("STRUCTURE_CHANGED: that file untouched, other file written, partial", async () => {
    holder.spliceMode = "structure-theme";
    const o = await runToEnd();
    expect(o.items["f-script-1"]).toMatchObject({
      status: "skipped",
      reasonCode: "VALIDATION_FAILED:STRUCTURE_CHANGED",
    });
    expect(o.items["f-other"].status).toBe("removed");
    expect(o.fin?.status).toBe("partial");
    expect(o.run.doNotPublish).toBe(false);
    expect(o.copy.files.get(THEME)).toBe(THEME_FILES[THEME]);
  });
});

describe("merchant copy for the two refusals (pinned)", () => {
  it.each([
    [
      "VALIDATION_FAILED:STRUCTURE_CHANGED",
      "Skipped. Removing code from this file would change how the rest of it reads, so we left the file alone.",
    ],
    [
      "VALIDATION_FAILED:CHECK_FAILED",
      "Skipped. We couldn't check this file safely, so we left it alone.",
    ],
  ])("%s", (code, text) => {
    expect(fixItemReasonCopy(code)).toBe(text);
  });
});

describe("a shop removed from the allowlist mid-run", () => {
  it("write step fails FLAG_OFF with zero upserts; items failed:FLAG_OFF; banner pinned", async () => {
    vi.stubEnv("CLEAN_COPY_ENABLED", undefined);
    vi.stubEnv("CLEAN_COPY_SHOPS", "shop-1.myshopify.com");
    const { runId } = await startRun();
    vi.stubEnv("CLEAN_COPY_SHOPS", "");
    await expect(writeCleanCopy(admin, runId, { sleep: async () => {} })).rejects.toThrow(
      /FLAG_OFF/,
    );
    expect(shop.count("CleanCopyUpsert")).toBe(0);
    const run = fake.state.fixRuns.find((x) => x.id === runId)!;
    expect(run).toMatchObject({ status: "failed", failureReason: "FLAG_OFF", doNotPublish: false });
    const items = fake.state.fixItems.filter((i) => i.fixRunId === runId);
    expect(items.map((i) => `${i.status}:${i.reasonCode}`)).toEqual([
      "failed:FLAG_OFF",
      "failed:FLAG_OFF",
    ]);
    const s = runSummary({
      status: run.status as string,
      doNotPublish: run.doNotPublish as boolean,
      failureReason: run.failureReason as string | null,
      items: items as unknown as Array<{ status: string }>,
      hasCopy: true,
    } as Parameters<typeof runSummary>[0]);
    expect(s.heading).toBe("We couldn't make your clean copy");
    expect(s.body).toBe(
      "Clean copy isn't available for your store right now. We made a copy of your theme before this stopped. Delete it from Online Store > Themes before you try again.",
    );
  });
});
