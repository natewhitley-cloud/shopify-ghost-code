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
vi.mock("../../app/models/fix-run.server", () => ({ getFixRunWithItems: vi.fn() }));
vi.mock("../../app/models/finding.server", () => ({ getFindingsForScan: vi.fn() }));

import { fixItemReasonCopy, runRefusalCopy } from "../../app/lib/clean-copy-view";
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
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockShop = getShopMetadata as ReturnType<typeof vi.fn>;
const mockRun = getFixRunWithItems as ReturnType<typeof vi.fn>;
const mockFindings = getFindingsForScan as ReturnType<typeof vi.fn>;

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
  mockAuth.mockResolvedValue({ session: { shop: DOMAIN } });
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
