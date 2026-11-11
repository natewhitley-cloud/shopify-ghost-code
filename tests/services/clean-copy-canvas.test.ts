/**
 * gc-tib audit M-c (D9): the Canvas hook's result is wired into preflight.
 * Detection itself is TODO(gc-dg5e); here the hook is forced to answer
 * "CANVAS_THEME", and preflight must refuse. If anyone drops the check, this
 * test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  fake: null as unknown as { db: unknown },
  manifest: null as unknown,
  canvas: vi.fn(),
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
  getIgnoredFindingsForShop: vi.fn(async () => ({ fingerprints: new Set(), appNames: new Set() })),
}));
vi.mock("../../inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("../../app/services/clean-copy-admin.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/services/clean-copy-admin.server")>();
  return { ...actual, canvasThemeRefusal: holder.canvas };
});

import {
  createFakeDb,
  DEFAULT_FINDINGS,
  FakeShopify,
  MAIN_ID,
  manifestFor,
  SCAN_ID,
  seed,
  SHOP_ID,
  THEME_FILES,
} from "./clean-copy.fakes";
import { createCleanCopyAdmin } from "../../app/services/clean-copy-admin.server";
import { preflightCleanCopy } from "../../app/services/clean-copy.server";

let shop: FakeShopify;

beforeEach(() => {
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  const fake = createFakeDb();
  holder.fake = fake;
  holder.manifest = manifestFor();
  seed(fake);
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  holder.canvas.mockReset().mockReturnValue(null);
});

const input = () => ({
  shopId: SHOP_ID,
  scanId: SCAN_ID,
  findingIds: DEFAULT_FINDINGS.map((f) => f.id),
  confirmedApps: ["Ghost App"],
  grantedScopes: ["write_themes"],
  admin: createCleanCopyAdmin(shop),
});

describe("Canvas themes (D9 hook)", () => {
  it("preflight refuses CANVAS_THEME whenever the hook returns a reason", async () => {
    holder.canvas.mockReturnValue("CANVAS_THEME");
    expect(await preflightCleanCopy(input())).toEqual({ ok: false, reason: "CANVAS_THEME" });
    expect(holder.canvas).toHaveBeenCalledWith(expect.objectContaining({ id: MAIN_ID }));
  });

  it("a null answer lets preflight continue", async () => {
    expect((await preflightCleanCopy(input())).ok).toBe(true);
  });

  it("the real hook still refuses nothing until gc-dg5e lands (no invented detection)", async () => {
    const actual = await vi.importActual<
      typeof import("../../app/services/clean-copy-admin.server")
    >("../../app/services/clean-copy-admin.server");
    expect(
      actual.canvasThemeRefusal({
        id: MAIN_ID,
        name: "Dawn",
        role: "MAIN",
        processing: false,
        processingFailed: false,
        updatedAt: null,
      }),
    ).toBeNull();
  });
});
