/**
 * Tests for app/routes/app.scans.$scanId_.clean-copy.tsx (gc-tib slice 5,
 * select + confirm).
 *
 *   - Loader: redirects (flag off, not Professional, foreign scan), block
 *     reasons, FILE_CHANGED on a changed file or span, the pre-check
 *     refusals, the 50 file limit, and that file content never leaves the
 *     loader beyond the span text.
 *   - Action: ok and RUN_ACTIVE redirect, refusals returned, malformed input
 *     rejected, confirmedApps passed through.
 *   - Rendering: copy, the submit rule, and the per-row refusal notes.
 */
import { createHash } from "node:crypto";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
const dbMock = vi.hoisted(() => ({ scan: { findFirst: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: dbMock }));
vi.mock("../../app/models/shop.server", () => ({ getShopMetadata: vi.fn() }));
vi.mock("../../app/models/scan.server", () => ({
  getScanById: vi.fn(),
  SUCCESSFUL_SCAN_STATUSES: ["COMPLETED", "PARTIAL"],
}));
vi.mock("../../app/models/finding.server", () => ({ getFindingsForScan: vi.fn() }));
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
}));
vi.mock("../../app/models/scan-manifest.server", () => ({ getScanManifest: vi.fn() }));
// The real freshness check (audit M-i); only the run request is mocked.
vi.mock("../../app/services/clean-copy.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/services/clean-copy.server")>();
  return { ...actual, requestCleanCopy: vi.fn() };
});
vi.mock("../../app/services/clean-copy-admin.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/services/clean-copy-admin.server")>();
  return { ...actual, createCleanCopyAdmin: vi.fn() };
});

import { candidateBlockCopy, runRefusalCopy } from "../../app/lib/clean-copy-view";
import type { CandidateGroup } from "../../app/lib/clean-copy-view";
import { getFindingsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import { getScanManifest } from "../../app/models/scan-manifest.server";
import { getScanById } from "../../app/models/scan.server";
import { getShopMetadata } from "../../app/models/shop.server";
import type {
  CleanCopySelectActionData,
  CleanCopySelectData,
} from "../../app/routes/app.scans.$scanId_.clean-copy";
import {
  appsNeedingConfirmation,
  canSubmitSelection,
  CLEAN_COPY_ALLOW_SCOPE,
  CLEAN_COPY_INTRO,
  CLEAN_COPY_NOTHING_TO_SELECT,
  CLEAN_COPY_SUBMIT,
  omittedFilesNotice,
  action,
  loader,
  default as CleanCopySelect,
} from "../../app/routes/app.scans.$scanId_.clean-copy";
import { createCleanCopyAdmin } from "../../app/services/clean-copy-admin.server";
import { requestCleanCopy } from "../../app/services/clean-copy.server";
import { authenticate } from "../../app/shopify.server";

const mockAuth = authenticate.admin as ReturnType<typeof vi.fn>;
const mockShop = getShopMetadata as ReturnType<typeof vi.fn>;
const mockScan = getScanById as ReturnType<typeof vi.fn>;
const mockFindings = getFindingsForScan as ReturnType<typeof vi.fn>;
const mockIgnores = getIgnoredFindingsForShop as ReturnType<typeof vi.fn>;
const mockManifest = getScanManifest as ReturnType<typeof vi.fn>;
const mockRequest = requestCleanCopy as ReturnType<typeof vi.fn>;
const mockMakeAdmin = createCleanCopyAdmin as ReturnType<typeof vi.fn>;

const md5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const DOMAIN = "test-shop.myshopify.com";
const SHOP = { id: "shop-1", domain: DOMAIN, plan: "Professional", lastThemePublishAt: null };
const MAIN_ID = "gid://shopify/OnlineStoreTheme/111";
const COMPLETED_AT = new Date("2026-11-09T10:00:00Z");
const SCAN = {
  id: "scan-1",
  shopId: "shop-1",
  themeId: MAIN_ID,
  status: "COMPLETED",
  completedAt: COMPLETED_AT,
  liveAppHooks: { embedApps: ["Judge.me"], scriptTagApps: [] },
};

const KLAVIYO_SPAN = '<script src="https://static.klaviyo.com/a.js"></script>';
const LOOX_SPAN = '<script src="https://x.loox.io/b.js"></script>';
const SECRET_MARKER = "PRIVATE-THEME-MARKER-xyz";
const THEME_LIQUID = `<!-- ${SECRET_MARKER} -->\n${KLAVIYO_SPAN}\n${LOOX_SPAN}\n`;

function finding(over: Record<string, unknown> = {}) {
  const start = THEME_LIQUID.indexOf(KLAVIYO_SPAN);
  return {
    id: "f-klaviyo",
    findingType: "GHOST_SCRIPT",
    filename: "layout/theme.liquid",
    lineNumber: 2,
    codeSnippet: KLAVIYO_SPAN,
    appName: "Klaviyo",
    spanStart: start,
    spanEnd: start + KLAVIYO_SPAN.length,
    spanSha256: sha256(KLAVIYO_SPAN),
    ...over,
  };
}

function looxFinding(over: Record<string, unknown> = {}) {
  const start = THEME_LIQUID.indexOf(LOOX_SPAN);
  return finding({
    id: "f-loox",
    lineNumber: 3,
    codeSnippet: LOOX_SPAN,
    appName: "Loox",
    spanStart: start,
    spanEnd: start + LOOX_SPAN.length,
    spanSha256: sha256(LOOX_SPAN),
    ...over,
  });
}

const getMainTheme = vi.fn();
const readFiles = vi.fn();
const getGrantedScopes = vi.fn();

function loaderArgs(scanId = "scan-1"): LoaderFunctionArgs {
  return {
    request: new Request(`https://${DOMAIN}/app/scans/${scanId}/clean-copy`),
    params: { scanId },
    context: {},
  } as unknown as LoaderFunctionArgs;
}

type LoaderResult = CleanCopySelectData | Response;
const run = (scanId?: string) => loader(loaderArgs(scanId)) as Promise<LoaderResult>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CLEAN_COPY_ENABLED", "true");
  mockAuth.mockResolvedValue({
    admin: {},
    session: { shop: DOMAIN, scope: "read_themes,write_themes" },
  });
  mockShop.mockResolvedValue(SHOP);
  mockScan.mockResolvedValue(SCAN);
  mockIgnores.mockResolvedValue({ fingerprints: new Set(), appNames: new Set() });
  mockFindings.mockResolvedValue([finding(), looxFinding()]);
  mockManifest.mockResolvedValue({
    scanId: "scan-1",
    themeId: MAIN_ID,
    createdAt: COMPLETED_AT,
    entries: [["layout/theme.liquid", md5(THEME_LIQUID), 100, 0, null]],
  });
  getMainTheme.mockResolvedValue({
    ok: true,
    value: {
      id: MAIN_ID,
      name: "Dawn",
      role: "MAIN",
      processing: false,
      processingFailed: false,
      updatedAt: new Date("2026-11-08T10:00:00Z"),
    },
  });
  readFiles.mockResolvedValue({
    ok: true,
    value: [
      { filename: "layout/theme.liquid", checksumMd5: md5(THEME_LIQUID), content: THEME_LIQUID },
    ],
  });
  getGrantedScopes.mockResolvedValue({ ok: true, value: ["read_themes", "write_themes"] });
  mockMakeAdmin.mockReturnValue({ getMainTheme, readFiles, getGrantedScopes });
  // This scan is the latest successful scan of its theme.
  dbMock.scan.findFirst.mockResolvedValue({ id: "scan-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function redirectTarget(res: unknown): string {
  expect(res).toBeInstanceOf(Response);
  const response = res as Response;
  expect(response.status).toBe(302);
  return response.headers.get("Location") ?? "";
}

describe("selection loader: redirects", () => {
  it("redirects to the scan page when the flag is off", async () => {
    vi.stubEnv("CLEAN_COPY_ENABLED", "false");
    expect(redirectTarget(await run())).toBe("/app/scans/scan-1");
    expect(readFiles).not.toHaveBeenCalled();
  });

  it("redirects when the plan is not Professional", async () => {
    mockShop.mockResolvedValue({ ...SHOP, plan: "Standard" });
    expect(redirectTarget(await run())).toBe("/app/scans/scan-1");
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("redirects for a scan that belongs to another shop, and for a missing scan", async () => {
    mockScan.mockResolvedValue({ ...SCAN, shopId: "shop-2" });
    expect(redirectTarget(await run())).toBe("/app/scans/scan-1");
    mockScan.mockResolvedValue(null);
    expect(redirectTarget(await run())).toBe("/app/scans/scan-1");
    expect(readFiles).not.toHaveBeenCalled();
  });

  it("404s when the session shop is unknown", async () => {
    mockShop.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 404 });
  });
});

describe("selection loader: candidates", () => {
  it("returns selectable candidates with the exact span text, grouped by app", async () => {
    const res = (await run()) as CleanCopySelectData;
    expect(res.refusal).toBeNull();
    expect(res.hasWriteScope).toBe(true);
    expect(res.groups.map((g) => g.appName)).toEqual(["Klaviyo", "Loox"]);
    expect(res.groups[0].selectable).toEqual([
      {
        findingId: "f-klaviyo",
        findingType: "GHOST_SCRIPT",
        filename: "layout/theme.liquid",
        lineNumber: 2,
        appName: "Klaviyo",
        spanText: KLAVIYO_SPAN,
        blocked: null,
      },
    ]);
    // One read of the main theme, for the one file.
    expect(readFiles).toHaveBeenCalledTimes(1);
    expect(readFiles).toHaveBeenCalledWith(MAIN_ID, ["layout/theme.liquid"]);
  });

  it("hasWriteScope is false without write_themes", async () => {
    getGrantedScopes.mockResolvedValue({ ok: true, value: ["read_themes"] });
    const res = (await run()) as CleanCopySelectData;
    expect(res.hasWriteScope).toBe(false);
  });

  it("blocks each candidate for its own reason", async () => {
    mockIgnores.mockResolvedValue({ fingerprints: new Set(), appNames: new Set(["Ignored App"]) });
    mockFindings.mockResolvedValue([
      finding({ id: "no-span", spanStart: null, spanEnd: null, spanSha256: null }),
      finding({ id: "bad-path", filename: "assets/theme.js" }),
      finding({ id: "ignored", appName: "Ignored App" }),
      finding({ id: "unknown", appName: null }),
      finding({ id: "embed", appName: "Judge.me" }),
      finding({ id: "other-type", findingType: "GHOST_PAGE" }),
      finding({ id: "ok" }),
    ]);
    const res = (await run()) as CleanCopySelectData;
    const all = res.groups.flatMap((g) => [...g.selectable, ...g.blocked]);
    const reasonOf = (id: string) => all.find((c) => c.findingId === id)?.blocked;
    expect(reasonOf("no-span")).toBe("NO_SPAN");
    expect(reasonOf("bad-path")).toBe("PATH_NOT_ALLOWED");
    expect(reasonOf("ignored")).toBe("IGNORED");
    expect(reasonOf("unknown")).toBe("APP_UNKNOWN");
    expect(reasonOf("embed")).toBe("APP_HAS_LIVE_EMBED");
    expect(reasonOf("ok")).toBeNull();
    // Only the 4 fixable types are candidates.
    expect(all.some((c) => c.findingId === "other-type")).toBe(false);
    // Blocked rows never carry code text.
    expect(all.filter((c) => c.blocked).every((c) => c.spanText === null)).toBe(true);
  });

  it("FILE_CHANGED when the live file md5 differs from the scan manifest", async () => {
    mockManifest.mockResolvedValue({
      scanId: "scan-1",
      themeId: MAIN_ID,
      createdAt: COMPLETED_AT,
      entries: [["layout/theme.liquid", md5("an older version"), 1, 0, null]],
    });
    const res = (await run()) as CleanCopySelectData;
    const all = res.groups.flatMap((g) => [...g.selectable, ...g.blocked]);
    expect(all.map((c) => c.blocked)).toEqual(["FILE_CHANGED", "FILE_CHANGED"]);
    expect(all.every((c) => c.spanText === null)).toBe(true);
  });

  it("FILE_CHANGED when the span text no longer hashes to the scan's hash", async () => {
    mockFindings.mockResolvedValue([finding({ spanSha256: sha256("something else") })]);
    const res = (await run()) as CleanCopySelectData;
    expect(res.groups[0].blocked[0]).toMatchObject({ blocked: "FILE_CHANGED", spanText: null });
  });

  it("FILE_CHANGED when the span is out of bounds or the file has no text body", async () => {
    mockFindings.mockResolvedValue([
      finding({ id: "oob", spanEnd: THEME_LIQUID.length + 5 }),
      looxFinding({ id: "empty", spanStart: 5, spanEnd: 5 }),
    ]);
    const res = (await run()) as CleanCopySelectData;
    const all = res.groups.flatMap((g) => g.blocked);
    expect(all.map((c) => c.blocked)).toEqual(["FILE_CHANGED", "FILE_CHANGED"]);

    readFiles.mockResolvedValue({
      ok: true,
      value: [{ filename: "layout/theme.liquid", checksumMd5: null, content: null }],
    });
    mockFindings.mockResolvedValue([finding()]);
    const res2 = (await run()) as CleanCopySelectData;
    expect(res2.groups[0].blocked[0].blocked).toBe("FILE_CHANGED");
  });

  it("never returns file content beyond the span text", async () => {
    const res = (await run()) as CleanCopySelectData;
    const json = JSON.stringify(res);
    expect(json).not.toContain(SECRET_MARKER);
    expect(json).not.toContain("codeSnippet");
    expect(json).toContain(KLAVIYO_SPAN.replace(/"/g, '\\"'));
  });

  it("shows the first 50 files and counts the rest", async () => {
    const many = Array.from({ length: 53 }, (_, i) =>
      finding({ id: `f-${i}`, filename: `snippets/s-${String(i).padStart(2, "0")}.liquid` }),
    );
    mockFindings.mockResolvedValue(many);
    readFiles.mockResolvedValue({ ok: true, value: [] });
    const res = (await run()) as CleanCopySelectData;
    expect(readFiles).toHaveBeenCalledTimes(1);
    expect(readFiles.mock.calls[0][1]).toHaveLength(50);
    expect(res.omittedFiles).toBe(3);
    expect(res.fileLimit).toBe(50);
    const shown = res.groups.flatMap((g) => [...g.selectable, ...g.blocked]);
    expect(shown).toHaveLength(50);
    expect(shown.some((c) => c.filename === "snippets/s-52.liquid")).toBe(false);
  });

  it("does not read files when every candidate is already blocked", async () => {
    mockFindings.mockResolvedValue([finding({ appName: null })]);
    const res = (await run()) as CleanCopySelectData;
    expect(readFiles).not.toHaveBeenCalled();
    expect(res.groups[0].blocked[0].blocked).toBe("APP_UNKNOWN");
  });
});

describe("selection loader: pre-check refusals (no candidates, an explanation instead)", () => {
  const expectRefusal = async (reason: string) => {
    const res = (await run()) as CleanCopySelectData;
    expect(res.refusal).toBe(reason);
    expect(res.groups).toEqual([]);
    expect(readFiles).not.toHaveBeenCalled();
  };

  it("SCAN_STALE when the scan did not succeed or the theme was published after it", async () => {
    mockScan.mockResolvedValue({ ...SCAN, status: "FAILED" });
    await expectRefusal("SCAN_STALE");
    mockScan.mockResolvedValue(SCAN);
    mockShop.mockResolvedValue({ ...SHOP, lastThemePublishAt: new Date("2026-11-09T11:00:00Z") });
    await expectRefusal("SCAN_STALE");
  });

  it("SCAN_STALE when MAIN is a different theme or changed after the scan", async () => {
    getMainTheme.mockResolvedValue({
      ok: true,
      value: { id: "gid://shopify/OnlineStoreTheme/999", updatedAt: null },
    });
    await expectRefusal("SCAN_STALE");
    getMainTheme.mockResolvedValue({
      ok: true,
      value: { id: MAIN_ID, updatedAt: new Date("2026-11-09T10:00:01Z") },
    });
    await expectRefusal("SCAN_STALE");
  });

  it("maps Admin failures and a missing MAIN theme", async () => {
    getMainTheme.mockResolvedValue({ ok: false, error: "ACCESS_DENIED", message: "" });
    await expectRefusal("ACCESS_DENIED");
    getMainTheme.mockResolvedValue({ ok: false, error: "TRANSIENT", message: "" });
    await expectRefusal("ADMIN_UNAVAILABLE");
    getMainTheme.mockResolvedValue({ ok: true, value: null });
    await expectRefusal("NO_MAIN_THEME");
  });

  it("MANIFEST_MISSING and EMBED_STATUS_UNKNOWN", async () => {
    mockManifest.mockResolvedValue(null);
    await expectRefusal("MANIFEST_MISSING");
    mockManifest.mockResolvedValue({
      scanId: "scan-1",
      themeId: MAIN_ID,
      createdAt: COMPLETED_AT,
      entries: [],
    });
    mockScan.mockResolvedValue({ ...SCAN, liveAppHooks: null });
    await expectRefusal("EMBED_STATUS_UNKNOWN");
  });

  it("explains a failed file read instead of showing unverified code", async () => {
    readFiles.mockResolvedValue({ ok: false, error: "TRANSIENT", message: "" });
    const res = (await run()) as CleanCopySelectData;
    expect(res.refusal).toBe("ADMIN_UNAVAILABLE");
    expect(res.groups).toEqual([]);
    readFiles.mockResolvedValue({ ok: false, error: "ACCESS_DENIED", message: "" });
    expect(((await run()) as CleanCopySelectData).refusal).toBe("ACCESS_DENIED");
  });
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

function actionArgs(form: FormData, scanId = "scan-1"): ActionFunctionArgs {
  return {
    request: new Request(`https://${DOMAIN}/app/scans/${scanId}/clean-copy`, {
      method: "POST",
      body: form,
    }),
    params: { scanId },
    context: {},
  } as unknown as ActionFunctionArgs;
}

function formOf(ids: string[], apps: string[] = []): FormData {
  const form = new FormData();
  for (const id of ids) form.append("findingIds", id);
  for (const app of apps) form.append("confirmedApps", app);
  return form;
}

type DataResult = { data: CleanCopySelectActionData; init: { status?: number } | null };

describe("selection action", () => {
  it("passes the selection through and redirects to the new run", async () => {
    mockRequest.mockResolvedValue({ ok: true, runId: "run-1" });
    const res = await action(actionArgs(formOf(["a", "b", "a"], ["Klaviyo", "Loox", "Klaviyo"])));
    expect(redirectTarget(res)).toBe("/app/clean-copy/run-1");
    expect(mockRequest).toHaveBeenCalledWith({
      shopId: "shop-1",
      scanId: "scan-1",
      findingIds: ["a", "b"],
      confirmedApps: ["Klaviyo", "Loox"],
      grantedScopes: ["read_themes", "write_themes"],
      admin: expect.anything(),
    });
  });

  it("redirects to the active run when one is already running", async () => {
    mockRequest.mockResolvedValue({ ok: false, reason: "RUN_ACTIVE", activeRunId: "run-9" });
    expect(redirectTarget(await action(actionArgs(formOf(["a"]))))).toBe("/app/clean-copy/run-9");
  });

  it("returns the refusal and the refused findings", async () => {
    mockRequest.mockResolvedValue({
      ok: false,
      reason: "FINDINGS_REFUSED",
      findings: [{ findingId: "a", reason: "APP_NOT_CONFIRMED" }],
    });
    const res = await action(actionArgs(formOf(["a"])));
    expect(res).toEqual({
      refusal: "FINDINGS_REFUSED",
      findings: [{ findingId: "a", reason: "APP_NOT_CONFIRMED" }],
    });
  });

  it("returns a plain refusal (no findings) for other refusals", async () => {
    mockRequest.mockResolvedValue({ ok: false, reason: "SCAN_STALE" });
    expect(await action(actionArgs(formOf(["a"])))).toEqual({
      refusal: "SCAN_STALE",
      findings: [],
    });
    mockRequest.mockResolvedValue({ ok: false, reason: "DISPATCH_FAILED" });
    expect(await action(actionArgs(formOf(["a"])))).toEqual({
      refusal: "DISPATCH_FAILED",
      findings: [],
    });
  });

  it("rejects a non-string value without calling the service", async () => {
    const form = formOf(["a"]);
    form.append("findingIds", new Blob(["x"]), "x.txt");
    const res = (await action(actionArgs(form))) as unknown as DataResult;
    expect(res.init?.status).toBe(400);
    expect(res.data.refusal).toBe("FINDINGS_REFUSED");
    const form2 = formOf(["a"]);
    form2.append("confirmedApps", new Blob(["x"]), "x.txt");
    expect(((await action(actionArgs(form2))) as unknown as DataResult).init?.status).toBe(400);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("rejects more than the maximum selection", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `f-${i}`);
    const res = (await action(actionArgs(formOf(ids)))) as unknown as DataResult;
    expect(res.init?.status).toBe(400);
    expect(res.data.refusal).toBe("TOO_MANY_FINDINGS");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("accepts exactly the maximum selection", async () => {
    mockRequest.mockResolvedValue({ ok: true, runId: "run-1" });
    const ids = Array.from({ length: 500 }, (_, i) => `f-${i}`);
    redirectTarget(await action(actionArgs(formOf(ids))));
    expect(mockRequest.mock.calls[0][0].findingIds).toHaveLength(500);
  });

  it("rejects an empty selection and oversized or blank ids", async () => {
    const empty = (await action(actionArgs(formOf([])))) as unknown as DataResult;
    expect(empty.init?.status).toBe(400);
    expect(empty.data.refusal).toBe("EMPTY_SELECTION");
    for (const bad of ["", "   ", "x".repeat(201)]) {
      const res = (await action(actionArgs(formOf([bad])))) as unknown as DataResult;
      expect(res.init?.status).toBe(400);
    }
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("404s for an unknown session shop", async () => {
    mockShop.mockResolvedValue(null);
    await expect(action(actionArgs(formOf(["a"])))).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Submit rule and rendering
// ---------------------------------------------------------------------------

const cand = (findingId: string, appName: string | null, blocked = null as never) => ({
  findingId,
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 2,
  appName,
  spanText: blocked ? null : KLAVIYO_SPAN,
  blocked,
});

const GROUPS: CandidateGroup[] = [
  {
    appName: "Klaviyo",
    selectable: [cand("k1", "Klaviyo"), cand("k2", "Klaviyo")],
    blocked: [],
  },
  { appName: "Loox", selectable: [cand("l1", "Loox")], blocked: [] },
];

describe("submit rule", () => {
  it("needs a selection, and a confirmation for every app with a selected candidate", () => {
    expect(canSubmitSelection(GROUPS, new Set(), new Set())).toBe(false);
    expect(canSubmitSelection(GROUPS, new Set(["k1"]), new Set())).toBe(false);
    expect(canSubmitSelection(GROUPS, new Set(["k1"]), new Set(["Klaviyo"]))).toBe(true);
    // Loox is selected too, so it needs its own confirmation.
    expect(canSubmitSelection(GROUPS, new Set(["k1", "l1"]), new Set(["Klaviyo"]))).toBe(false);
    expect(canSubmitSelection(GROUPS, new Set(["k1", "l1"]), new Set(["Klaviyo", "Loox"]))).toBe(
      true,
    );
    // A confirmation for an app with no selection is irrelevant.
    expect(canSubmitSelection(GROUPS, new Set(["k1"]), new Set(["Klaviyo", "Loox"]))).toBe(true);
  });

  it("lists the apps that need a confirmation", () => {
    expect(appsNeedingConfirmation(GROUPS, new Set(["l1", "k2"]))).toEqual(["Klaviyo", "Loox"]);
    expect(appsNeedingConfirmation(GROUPS, new Set())).toEqual([]);
  });
});

function render(loaderData: CleanCopySelectData, actionData?: CleanCopySelectActionData): string {
  const Stub = createRoutesStub([
    {
      id: "select",
      path: "/app/scans/:scanId/clean-copy",
      Component: CleanCopySelect as never,
      loader: () => loaderData,
      action: () => actionData ?? null,
    },
  ]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/app/scans/scan-1/clean-copy"],
      hydrationData: {
        loaderData: { select: loaderData },
        actionData: actionData ? { select: actionData } : undefined,
      },
    }),
  );
}

const DATA: CleanCopySelectData = {
  scanId: "scan-1",
  groups: GROUPS,
  hasWriteScope: true,
  refusal: null,
  omittedFiles: 0,
  fileLimit: 50,
};

describe("selection page", () => {
  it("renders the intro, one section per app, the confirm checkbox, rows and the submit button", () => {
    const html = render(DATA);
    expect(html).toContain(CLEAN_COPY_INTRO);
    expect(html).toContain('heading="Klaviyo"');
    expect(html).toContain('heading="Loox"');
    expect(html).toContain("I&#x27;ve uninstalled Klaviyo");
    expect(html).toContain("layout/theme.liquid, line 2");
    expect(html).toContain("static.klaviyo.com/a.js");
    expect(html).toMatch(new RegExp(`<s-button[^>]*>${CLEAN_COPY_SUBMIT}</s-button>`));
    expect(html).not.toContain(CLEAN_COPY_ALLOW_SCOPE);
    // Nothing starts checked.
    expect(html).not.toMatch(/<s-checkbox[^>]*\schecked/);
    // The button starts disabled.
    expect(html).toMatch(/<s-button[^>]*disabled/);
  });

  it("the button asks for theme permission when write_themes is missing", () => {
    const html = render({ ...DATA, hasWriteScope: false });
    expect(html).toContain(CLEAN_COPY_ALLOW_SCOPE);
  });

  it("shows blocked rows greyed with their reason copy, and no checkbox for them", () => {
    const html = render({
      ...DATA,
      groups: [
        {
          appName: "Judge.me",
          selectable: [],
          blocked: [cand("j1", "Judge.me", "APP_HAS_LIVE_EMBED" as never)],
        },
        { appName: null, selectable: [], blocked: [cand("u1", null, "APP_UNKNOWN" as never)] },
      ],
    });
    expect(html).toContain(candidateBlockCopy("APP_HAS_LIVE_EMBED").replace(/'/g, "&#x27;"));
    expect(html).toContain('heading="Unknown app"');
    expect(html).not.toContain("<s-checkbox");
    expect(html).not.toContain("<s-button");
  });

  it("shows a pre-check refusal as a critical banner and offers no button", () => {
    const html = render({ ...DATA, groups: [], refusal: "SCAN_STALE" });
    expect(html).toContain('tone="critical"');
    expect(html).toContain(runRefusalCopy("SCAN_STALE"));
    expect(html).not.toContain("<s-button");
    expect(html).not.toContain(CLEAN_COPY_NOTHING_TO_SELECT);
  });

  it("says so when nothing can be removed", () => {
    expect(render({ ...DATA, groups: [] })).toContain(CLEAN_COPY_NOTHING_TO_SELECT);
  });

  it("shows the omitted-files note", () => {
    const html = render({ ...DATA, omittedFiles: 3 });
    expect(html).toContain(omittedFilesNotice(3, 50).replace(/'/g, "&#x27;"));
  });

  it("renders the action refusal banner and a note on each refused row", () => {
    const html = render(DATA, {
      refusal: "FINDINGS_REFUSED",
      findings: [{ findingId: "k1", reason: "APP_NOT_CONFIRMED" }],
    });
    expect(html).toContain(runRefusalCopy("FINDINGS_REFUSED").replace(/'/g, "&#x27;"));
    expect(html).toContain("Confirm you&#x27;ve uninstalled this app first.");
  });

  it("never prints a machine code", () => {
    const html = render(DATA, {
      refusal: "SOMETHING_NEW",
      findings: [{ findingId: "k1", reason: "ODD_CODE" }],
    });
    expect(html).not.toContain("SOMETHING_NEW");
    expect(html).not.toContain("ODD_CODE");
  });
});

describe("audit M-h: granted scopes are read live, never from the session", () => {
  it("loader: a stale session claiming write_themes does not count", async () => {
    mockAuth.mockResolvedValue({
      admin: {},
      session: { shop: DOMAIN, scope: "read_themes,write_themes" },
    });
    getGrantedScopes.mockResolvedValue({ ok: true, value: ["read_themes"] });
    expect(((await run()) as CleanCopySelectData).hasWriteScope).toBe(false);
  });

  it("loader: a live grant counts even when the session predates it", async () => {
    mockAuth.mockResolvedValue({ admin: {}, session: { shop: DOMAIN, scope: "read_themes" } });
    expect(((await run()) as CleanCopySelectData).hasWriteScope).toBe(true);
  });

  it("loader: a failed scope read means no scope (the page asks again)", async () => {
    getGrantedScopes.mockResolvedValue({ ok: false, error: "TRANSIENT", message: "" });
    expect(((await run()) as CleanCopySelectData).hasWriteScope).toBe(false);
  });

  it("action: passes the live scopes to the service", async () => {
    mockAuth.mockResolvedValue({
      admin: {},
      session: { shop: DOMAIN, scope: "read_themes,write_themes" },
    });
    getGrantedScopes.mockResolvedValue({ ok: true, value: ["read_themes"] });
    mockRequest.mockResolvedValue({ ok: false, reason: "SCOPE_MISSING" });
    await action(actionArgs(formOf(["a"], ["Klaviyo"])));
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: ["read_themes"] }),
    );
  });

  it("action: a failed scope read refuses without calling the service", async () => {
    getGrantedScopes.mockResolvedValue({ ok: false, error: "TRANSIENT", message: "" });
    const res = (await action(actionArgs(formOf(["a"], ["Klaviyo"])))) as unknown as DataResult;
    expect(res.data.refusal).toBe("ADMIN_UNAVAILABLE");
    expect(mockRequest).not.toHaveBeenCalled();
    getGrantedScopes.mockResolvedValue({ ok: false, error: "ACCESS_DENIED", message: "" });
    const denied = (await action(actionArgs(formOf(["a"], ["Klaviyo"])))) as unknown as DataResult;
    expect(denied.data.refusal).toBe("ACCESS_DENIED");
  });
});

describe("audit M-i: the loader uses the service's freshness check", () => {
  it("SCAN_STALE when a newer successful scan of the theme exists", async () => {
    dbMock.scan.findFirst.mockResolvedValue({ id: "scan-2" });
    const res = (await run()) as CleanCopySelectData;
    expect(res.refusal).toBe("SCAN_STALE");
    expect(res.groups).toEqual([]);
    expect(readFiles).not.toHaveBeenCalled();
  });
});
