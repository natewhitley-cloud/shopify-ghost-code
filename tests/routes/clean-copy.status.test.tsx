/**
 * Tests for app/routes/app.clean-copy.$runId.tsx (gc-tib slice 5, status and
 * result).
 *
 *   - Loader: a run of another shop (or none) is a 404; the preview link and
 *     editor links appear only when the run summary allows a preview; no
 *     file content or code text is ever returned; line numbers are read only
 *     for a finished run.
 *   - Rendering: banner copy per state, buttons, results lists, footer note.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/models/shop.server", () => ({ getShopMetadata: vi.fn() }));
vi.mock("../../app/models/fix-run.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/models/fix-run.server")>();
  return { ...actual, getFixRunWithItems: vi.fn() };
});
vi.mock("../../app/services/clean-copy-admin.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/services/clean-copy-admin.server")>();
  return { ...actual, createCleanCopyAdmin: vi.fn() };
});
vi.mock("../../app/models/finding.server", () => ({ getFindingsForScan: vi.fn() }));

import {
  fixItemReasonCopy,
  LIVE_THEME_CHANGED_COPY,
  PUBLISHED_COPY_COPY,
  runRefusalCopy,
} from "../../app/lib/clean-copy-view";
import { getFindingsForScan } from "../../app/models/finding.server";
import { getFixRunWithItems } from "../../app/models/fix-run.server";
import { getShopMetadata } from "../../app/models/shop.server";
import CleanCopyRun, {
  CLEAN_COPY_FOOTER_NOTE,
  CLEAN_COPY_POLL_TIMEOUT,
  loader,
  removedItemLabel,
} from "../../app/routes/app.clean-copy.$runId";
import type { CleanCopyRunData } from "../../app/routes/app.clean-copy.$runId";
import { createCleanCopyAdmin } from "../../app/services/clean-copy-admin.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockShop = getShopMetadata as ReturnType<typeof vi.fn>;
const mockRun = getFixRunWithItems as ReturnType<typeof vi.fn>;
const mockFindings = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockMakeAdmin = createCleanCopyAdmin as ReturnType<typeof vi.fn>;
const getMainTheme = vi.fn();
const SOURCE_GID = "gid://shopify/OnlineStoreTheme/111";
const COPY_CREATED = new Date("2026-11-10T12:00:00Z");
const mainTheme = (over: Record<string, unknown> = {}) => ({
  ok: true,
  value: {
    id: SOURCE_GID,
    name: "Dawn",
    role: "MAIN",
    processing: false,
    processingFailed: false,
    updatedAt: new Date("2026-11-10T11:00:00Z"),
    ...over,
  },
});

const DOMAIN = "test-shop.myshopify.com";
const COPY_GID = "gid://shopify/OnlineStoreTheme/222";

const item = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  findingId: "f1",
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  spanStart: 10,
  spanEnd: 60,
  spanSha256: "hash",
  preMd5: "md5",
  postMd5: "md5b",
  status: "removed",
  reasonCode: null,
  ...over,
});

const baseRun = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  shopId: "shop-1",
  scanId: "scan-1",
  sourceThemeId: "gid://shopify/OnlineStoreTheme/111",
  copyThemeId: COPY_GID,
  copyThemeName: "Dawn (GhostCode clean copy abc123)",
  copyCreatedAt: COPY_CREATED,
  updatedAt: new Date(),
  status: "completed",
  failureReason: null,
  doNotPublish: false,
  items: [item()],
  ...over,
});

function args(runId = "run-1"): LoaderFunctionArgs {
  return {
    request: new Request(`https://${DOMAIN}/app/clean-copy/${runId}`),
    params: { runId },
    context: {},
  } as unknown as LoaderFunctionArgs;
}
const run = () => loader(args());

beforeEach(() => {
  vi.resetAllMocks();
  mockAuth.mockResolvedValue({ admin: {}, session: { shop: DOMAIN } });
  getMainTheme.mockResolvedValue(mainTheme());
  mockMakeAdmin.mockReturnValue({ getMainTheme });
  mockShop.mockResolvedValue({ id: "shop-1", domain: DOMAIN });
  mockRun.mockResolvedValue(baseRun());
  mockFindings.mockResolvedValue([
    { id: "f1", lineNumber: 7, codeSnippet: "SECRET-SNIPPET", filename: "layout/theme.liquid" },
  ]);
});

describe("status loader", () => {
  it("404s for a run that belongs to another shop, or does not exist", async () => {
    mockRun.mockResolvedValue(baseRun({ shopId: "shop-2" }));
    await expect(run()).rejects.toMatchObject({ status: 404 });
    mockRun.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 404 });
    mockShop.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 404 });
  });

  it("a completed run gets the preview link, the library link and editor links", async () => {
    const res = await run();
    expect(res.summary.tone).toBe("success");
    expect(res.previewUrl).toBe(`https://${DOMAIN}/?preview_theme_id=222`);
    expect(res.themeLibraryUrl).toBe("https://admin.shopify.com/store/test-shop/themes");
    expect(res.editorUrls).toEqual({
      "layout/theme.liquid":
        "https://admin.shopify.com/store/test-shop/themes/222?key=layout%2Ftheme.liquid",
    });
    expect(res.items).toEqual([
      {
        id: "i1",
        filename: "layout/theme.liquid",
        findingType: "GHOST_SCRIPT",
        status: "removed",
        reasonCode: null,
        lineNumber: 7,
      },
    ]);
  });

  it("a partial run with something removed still gets a preview; with nothing removed it does not", async () => {
    mockRun.mockResolvedValue(
      baseRun({
        status: "partial",
        items: [
          item(),
          item({ id: "i2", findingId: "f2", status: "skipped", reasonCode: "FILE_CHANGED" }),
        ],
      }),
    );
    expect((await run()).previewUrl).not.toBeNull();
    mockRun.mockResolvedValue(
      baseRun({
        status: "partial",
        items: [item({ status: "skipped", reasonCode: "FILE_CHANGED" })],
      }),
    );
    const none = await run();
    expect(none.previewUrl).toBeNull();
    expect(none.editorUrls).toEqual({});
  });

  it("no preview or editor links for do-not-publish, failed, or active runs", async () => {
    for (const over of [
      { doNotPublish: true },
      { status: "failed", failureReason: "SCAN_STALE" },
      { status: "writing", copyThemeId: null },
      { status: "duplicating", copyThemeId: null },
    ]) {
      mockRun.mockResolvedValue(baseRun(over));
      const res = await run();
      expect(res.previewUrl).toBeNull();
      expect(res.editorUrls).toEqual({});
      expect(res.summary.showPreview).toBe(false);
    }
  });

  it("an active run reports active and reads no findings", async () => {
    mockRun.mockResolvedValue(baseRun({ status: "writing", items: [item({ status: "pending" })] }));
    const res = await run();
    expect(res.summary.active).toBe(true);
    expect(mockFindings).not.toHaveBeenCalled();
    expect(res.items[0].lineNumber).toBeNull();
  });

  it("line number is null when the scan's finding is gone", async () => {
    mockFindings.mockResolvedValue([]);
    expect((await run()).items[0].lineNumber).toBeNull();
  });

  it("a copy with no preview id (malformed) returns no preview link", async () => {
    mockRun.mockResolvedValue(baseRun({ copyThemeId: "not-a-gid" }));
    const res = await run();
    expect(res.previewUrl).toBeNull();
    expect(res.editorUrls).toEqual({});
  });

  it("never returns file content, code text, spans or hashes", async () => {
    const json = JSON.stringify(await run());
    expect(json).not.toContain("SECRET-SNIPPET");
    for (const key of [
      "codeSnippet",
      "content",
      "spanStart",
      "spanEnd",
      "spanSha256",
      "preMd5",
      "postMd5",
    ]) {
      expect(json).not.toContain(key);
    }
  });
});

function render(data: CleanCopyRunData): string {
  const Stub = createRoutesStub([
    {
      id: "run",
      path: "/app/clean-copy/:runId",
      Component: CleanCopyRun as never,
      loader: () => data,
    },
  ]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/app/clean-copy/run-1"],
      hydrationData: { loaderData: { run: data } },
    }),
  );
}

async function renderRun(over: Record<string, unknown> = {}): Promise<string> {
  mockRun.mockResolvedValue(baseRun(over));
  return render(await run());
}

const esc = (s: string) => s.replace(/'/g, "&#x27;");

describe("status page", () => {
  it("completed: success banner, Preview and Open theme library buttons, removed list, footer note", async () => {
    const html = await renderRun();
    expect(html).toContain('tone="success"');
    expect(html).toContain('heading="Your clean copy is ready"');
    expect(html).toContain("Preview clean copy");
    expect(html).toContain(`href="https://${DOMAIN}/?preview_theme_id=222"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Open theme library");
    expect(html).toContain("Removed from layout/theme.liquid, line 7");
    expect(html).toContain("Open in code editor");
    expect(html).toContain(esc(CLEAN_COPY_FOOTER_NOTE));
    expect(html).toContain("Dawn (GhostCode clean copy abc123)");
  });

  it("partial: warning banner, and the not-removed items with their reason copy", async () => {
    const html = await renderRun({
      status: "partial",
      items: [
        item(),
        item({ id: "i2", findingId: "f2", status: "skipped", reasonCode: "FILE_CHANGED" }),
      ],
    });
    expect(html).toContain('tone="warning"');
    expect(html).toContain("1 of 2");
    expect(html).toContain("Not removed");
    expect(html).toContain(esc(fixItemReasonCopy("FILE_CHANGED")));
    expect(html).not.toContain("FILE_CHANGED");
  });

  it("failed: critical banner with the reason copy, no buttons, no code editor links", async () => {
    const html = await renderRun({
      status: "failed",
      failureReason: "SCAN_STALE",
      copyThemeId: null,
      copyThemeName: null,
      items: [item({ status: "failed", reasonCode: "SCAN_STALE" })],
    });
    expect(html).toContain('tone="critical"');
    expect(html).toContain(esc(runRefusalCopy("SCAN_STALE")));
    expect(html).not.toContain("<s-button");
    expect(html).not.toContain(CLEAN_COPY_FOOTER_NOTE);
    expect(html).not.toContain("SCAN_STALE");
  });

  it("do-not-publish: critical, says not to publish, no preview button, no removed list", async () => {
    const html = await renderRun({ doNotPublish: true });
    expect(html).toContain('tone="critical"');
    expect(html).toContain("Don&#x27;t publish this copy");
    expect(html).not.toContain("Preview clean copy");
    expect(html).not.toContain("<s-button");
    expect(html).not.toContain("Removed from");
  });

  it("active: info banner, no buttons, no results list, no footer", async () => {
    const html = await renderRun({
      status: "writing",
      copyThemeId: null,
      items: [item({ status: "pending" })],
    });
    expect(html).toContain('tone="info"');
    expect(html).toContain("Removing leftover code from the copy");
    expect(html).not.toContain("<s-button");
    expect(html).not.toContain("Removed from");
    expect(html).not.toContain(CLEAN_COPY_FOOTER_NOTE);
  });

  it("a not-removed item with no reason code still gets plain copy", async () => {
    const html = await renderRun({
      status: "partial",
      items: [item(), item({ id: "i2", findingId: "f2", status: "failed", reasonCode: null })],
    });
    expect(html).toContain(esc(fixItemReasonCopy("UNKNOWN")));
  });

  it("labels", () => {
    expect(removedItemLabel({ filename: "a.liquid", lineNumber: 3 })).toBe(
      "Removed from a.liquid, line 3",
    );
    expect(removedItemLabel({ filename: "a.liquid", lineNumber: null })).toBe(
      "Removed from a.liquid",
    );
    expect(CLEAN_COPY_POLL_TIMEOUT.length).toBeGreaterThan(0);
  });
});

describe("audit H2: stale-copy warning", () => {
  it("MAIN unchanged since the copy: no notice, preview kept", async () => {
    const res = await run();
    expect(res.liveTheme).toBeNull();
    expect(res.previewUrl).not.toBeNull();
  });

  it("MAIN edited after the copy was made: warning, no preview or editor links, library kept", async () => {
    getMainTheme.mockResolvedValue(mainTheme({ updatedAt: new Date("2026-11-10T12:30:00Z") }));
    const res = await run();
    expect(res.liveTheme).toEqual({ tone: "warning", text: LIVE_THEME_CHANGED_COPY });
    expect(res.summary.showPreview).toBe(false);
    expect(res.previewUrl).toBeNull();
    expect(res.editorUrls).toEqual({});
    const html = render(res);
    expect(html).toContain(esc(LIVE_THEME_CHANGED_COPY));
    expect(html).not.toContain("Preview clean copy");
    expect(html).toContain("Open theme library");
  });

  it("another theme was published: warning", async () => {
    getMainTheme.mockResolvedValue(mainTheme({ id: "gid://shopify/OnlineStoreTheme/999" }));
    expect((await run()).liveTheme?.tone).toBe("warning");
  });

  it("the merchant published this copy: neutral note, no warning, no preview", async () => {
    getMainTheme.mockResolvedValue(mainTheme({ id: COPY_GID }));
    const res = await run();
    expect(res.liveTheme).toEqual({ tone: "info", text: PUBLISHED_COPY_COPY });
    expect(res.previewUrl).toBeNull();
    expect(render(res)).toContain(PUBLISHED_COPY_COPY);
  });

  it("a failed or throwing MAIN read shows nothing and does not crash", async () => {
    getMainTheme.mockResolvedValue({ ok: false, error: "TRANSIENT", message: "" });
    expect((await run()).liveTheme).toBeNull();
    getMainTheme.mockRejectedValue(new Error("boom"));
    const res = await run();
    expect(res.liveTheme).toBeNull();
    expect(res.previewUrl).not.toBeNull();
  });

  it("not checked for active runs or runs without a copy (r2 gc-tib.13: failed runs with a copy are)", async () => {
    for (const over of [
      { status: "failed", failureReason: "SCAN_STALE", copyThemeId: null },
      { status: "writing", items: [item({ status: "pending" })] },
    ]) {
      mockRun.mockResolvedValue(baseRun(over));
      expect((await run()).liveTheme).toBeNull();
    }
    expect(getMainTheme).not.toHaveBeenCalled();
  });
});

describe("audit M-j / M-d / logic 12 / M-a on the status page", () => {
  it("an active run past the stale threshold is shown as stopped, not polling", async () => {
    mockRun.mockResolvedValue(
      baseRun({
        status: "writing",
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        items: [item({ status: "pending" })],
      }),
    );
    const res = await run();
    expect(res.summary.active).toBe(false);
    expect(res.summary.tone).toBe("critical");
    expect(res.summary.body).toContain(runRefusalCopy("STALE"));
  });

  it("a failed run that made a copy tells the merchant to delete it first", async () => {
    mockRun.mockResolvedValue(baseRun({ status: "failed", failureReason: "INTERNAL_ERROR" }));
    const res = await run();
    expect(res.summary.body).toContain(
      "Delete it from Online Store > Themes before you try again.",
    );
    mockRun.mockResolvedValue(
      baseRun({ status: "failed", failureReason: "INTERNAL_ERROR", copyThemeId: null }),
    );
    expect((await run()).summary.body).not.toContain("Delete it");
  });

  it("shows the copy name only when a copy exists", async () => {
    mockRun.mockResolvedValue(
      baseRun({ status: "failed", failureReason: "DUPLICATE_FAILED", copyThemeId: null }),
    );
    const res = await run();
    expect(res.run.copyThemeName).toBeNull();
    expect(render(res)).not.toContain("Copy name:");
  });

  it("while active, says not to publish the copy yet", async () => {
    mockRun.mockResolvedValue(baseRun({ status: "writing", items: [item({ status: "pending" })] }));
    expect((await run()).summary.body).toContain("Don't publish the copy until this finishes.");
  });

  it("a copy published mid-write never claims the live theme was unchanged", async () => {
    mockRun.mockResolvedValue(
      baseRun({
        status: "failed",
        failureReason: "COPY_PUBLISHED_DURING_WRITE",
        doNotPublish: true,
        items: [item({ status: "failed", reasonCode: "COPY_PUBLISHED_DURING_WRITE" })],
      }),
    );
    const res = await run();
    expect(res.summary.heading).toBe("The copy was published before we finished");
    expect(res.summary.body).not.toContain("Your live theme was not changed.");
  });
});

describe("audit r2 gc-tib.13 / gc-tib.15: banners follow the live theme", () => {
  const UNCHANGED = "Your live theme was not changed.";
  const PUBLISH_IT = "Preview the copy, then publish it";
  const copyLive = () => getMainTheme.mockResolvedValue(mainTheme({ id: COPY_GID }));
  const otherLive = () =>
    getMainTheme.mockResolvedValue(mainTheme({ id: "gid://shopify/OnlineStoreTheme/999" }));
  const failedRun = (over: Record<string, unknown> = {}) =>
    baseRun({
      status: "failed",
      failureReason: "INTERNAL_ERROR",
      items: [item({ status: "failed", reasonCode: "INTERNAL_ERROR" })],
      ...over,
    });

  it("do-not-publish copy that is now live: says so, never 'not changed' or 'delete the copy'", async () => {
    mockRun.mockResolvedValue(failedRun({ doNotPublish: true }));
    copyLive();
    const res = await run();
    expect(res.summary.heading).toBe("This copy is now your live theme");
    expect(res.summary.body).not.toContain(UNCHANGED);
    expect(res.summary.body).not.toContain("Delete the copy");
    expect(res.summary.body).toContain("Publish your previous theme again");
    expect(res.liveTheme).toBeNull();
    expect(res.previewUrl).toBeNull();
  });

  it("do-not-publish copy still unpublished: the original warning", async () => {
    mockRun.mockResolvedValue(failedRun({ doNotPublish: true }));
    const res = await run();
    expect(getMainTheme).toHaveBeenCalled();
    expect(res.summary.heading).toBe("Don't publish this copy");
    expect(res.summary.body).toContain(UNCHANGED);
  });

  it("a completed do-not-publish run gets no extra live-theme notice", async () => {
    mockRun.mockResolvedValue(baseRun({ doNotPublish: true }));
    copyLive();
    expect((await run()).liveTheme).toBeNull();
  });

  it("failed run whose copy was published: revert advice, no 'not changed', no 'delete it'", async () => {
    mockRun.mockResolvedValue(failedRun());
    copyLive();
    const { body } = (await run()).summary;
    expect(body).not.toContain(UNCHANGED);
    expect(body).not.toContain("Delete it from");
    expect(body).toContain("it's now your live theme");
  });

  it("failed run, another theme now live: no 'not changed', still delete the copy", async () => {
    mockRun.mockResolvedValue(failedRun());
    otherLive();
    const { body } = (await run()).summary;
    expect(body).not.toContain(UNCHANGED);
    expect(body).toContain("Delete it from Online Store > Themes before you try again.");
  });

  it("failed run, live theme unchanged or unreadable: original copy", async () => {
    mockRun.mockResolvedValue(failedRun());
    expect((await run()).summary.body).toContain(UNCHANGED);
    getMainTheme.mockRejectedValue(new Error("boom"));
    expect((await run()).summary.body).toContain(UNCHANGED);
  });

  it("a stale run with a published copy is checked too", async () => {
    mockRun.mockResolvedValue(
      baseRun({
        status: "writing",
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        items: [item({ status: "pending" })],
      }),
    );
    copyLive();
    const { summary } = await run();
    expect(summary.active).toBe(false);
    expect(summary.body).not.toContain(UNCHANGED);
  });

  it("completed, copy published: no 'not changed', no 'publish it', notice kept", async () => {
    copyLive();
    const res = await run();
    expect(res.summary.body).not.toContain(UNCHANGED);
    expect(res.summary.body).not.toContain(PUBLISH_IT);
    expect(res.liveTheme).toEqual({ tone: "info", text: PUBLISHED_COPY_COPY });
  });

  it("completed or partial, live theme changed: no 'publish it', no preview", async () => {
    for (const over of [
      {},
      {
        status: "partial",
        items: [
          item(),
          item({ id: "i2", findingId: "f2", status: "skipped", reasonCode: "FILE_CHANGED" }),
        ],
      },
    ]) {
      mockRun.mockResolvedValue(baseRun(over));
      otherLive();
      const res = await run();
      expect(res.summary.body).not.toContain(PUBLISH_IT);
      expect(res.summary.body).not.toContain(UNCHANGED);
      expect(res.summary.showPreview).toBe(false);
      expect(res.liveTheme?.tone).toBe("warning");
    }
  });

  it("WRITE_REFUSED says the live theme was unchanged once, not twice", async () => {
    mockRun.mockResolvedValue(failedRun({ failureReason: "WRITE_REFUSED" }));
    const { body } = (await run()).summary;
    expect(body.match(/live theme/g)).toHaveLength(1);
    expect(body).toContain(UNCHANGED);
  });

  it("published mid-write, then the merchant put their theme back: no 'it's now your live theme'", async () => {
    mockRun.mockResolvedValue(
      failedRun({ failureReason: "COPY_PUBLISHED_DURING_WRITE", doNotPublish: true }),
    );
    const res = await run();
    expect(res.summary.body).not.toContain("now your live theme");
    expect(res.summary.body).toContain("Don't publish the copy.");
    copyLive();
    expect((await run()).summary.body).toContain("It's now your live theme");
  });
});
