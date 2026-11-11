/**
 * Tests for app/services/clean-copy-admin.server.ts (gc-tib slice 4): the
 * Admin adapter and its HARD write guard, against the FakeShopify server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeEach } from "vitest";

import { BODY_MARKER, FakeShopify, MAIN_ID, THEME_FILES } from "./clean-copy.fakes";
import {
  createCleanCopyAdmin,
  isAllowedFixPath,
  MAX_FILES_PER_REQUEST,
} from "../../app/services/clean-copy-admin.server";

let shop: FakeShopify;
let admin: ReturnType<typeof createCleanCopyAdmin>;

beforeEach(() => {
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  admin = createCleanCopyAdmin(shop);
});

async function readyCopy(name = "Dawn - clean copy x") {
  const dup = await admin.duplicateTheme(MAIN_ID, name);
  if (!dup.ok) throw new Error("dup failed");
  await admin.getTheme(dup.value.id); // processing -> ready
  return dup.value.id;
}

const file = { filename: "layout/theme.liquid", content: "<html></html>" };

describe("write guard (never writes MAIN or the source theme)", () => {
  it("refuses a write when the target role is MAIN, even if asked", async () => {
    const res = await admin.upsertFiles({
      themeId: MAIN_ID,
      sourceThemeId: "gid://shopify/OnlineStoreTheme/999",
      files: [file],
    });
    expect(res).toMatchObject({ ok: false, error: "WRITE_REFUSED" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
    expect(shop.themes.get(MAIN_ID)!.files.get(file.filename)).toBe(THEME_FILES[file.filename]);
  });

  it("refuses a write whose target is the run's source theme", async () => {
    const copyId = await readyCopy();
    const res = await admin.upsertFiles({ themeId: copyId, sourceThemeId: copyId, files: [file] });
    expect(res).toMatchObject({ ok: false, error: "WRITE_REFUSED" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it.each(["DEVELOPMENT", "DEMO", "ARCHIVED", "LOCKED"])("refuses role %s", async (role) => {
    const copyId = await readyCopy();
    shop.themes.get(copyId)!.role = role;
    const res = await admin.upsertFiles({ themeId: copyId, sourceThemeId: MAIN_ID, files: [file] });
    expect(res).toMatchObject({ ok: false, error: "WRITE_REFUSED" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("refuses a copy that is still processing", async () => {
    const dup = await admin.duplicateTheme(MAIN_ID, "n");
    if (!dup.ok) throw new Error();
    shop.processingChecks = 5;
    const res = await admin.upsertFiles({
      themeId: dup.value.id,
      sourceThemeId: MAIN_ID,
      files: [file],
    });
    expect(res).toMatchObject({ ok: false, error: "WRITE_REFUSED" });
  });

  it.each([
    "assets/app.js",
    "config/settings_data.json",
    "templates/index.json",
    "locales/en.default.json",
    "layout/../config/x.liquid",
    "snippets/a/b.liquid",
  ])("refuses a disallowed path: %s", async (filename) => {
    const copyId = await readyCopy();
    const res = await admin.upsertFiles({
      themeId: copyId,
      sourceThemeId: MAIN_ID,
      files: [{ filename, content: "x" }],
    });
    expect(res).toMatchObject({ ok: false, error: "WRITE_REFUSED" });
    expect(shop.count("CleanCopyUpsert")).toBe(0);
  });

  it("refuses an empty write and more than 50 files", async () => {
    const copyId = await readyCopy();
    const many = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) => ({
      filename: `snippets/s${i}.liquid`,
      content: "x",
    }));
    for (const files of [[], many]) {
      const res = await admin.upsertFiles({ themeId: copyId, sourceThemeId: MAIN_ID, files });
      expect(res).toMatchObject({ ok: false, error: "WRITE_REFUSED" });
    }
  });

  it("writes an UNPUBLISHED copy as TEXT and returns the job", async () => {
    const copyId = await readyCopy();
    shop.jobPollsUntilDone = 2;
    const res = await admin.upsertFiles({ themeId: copyId, sourceThemeId: MAIN_ID, files: [file] });
    expect(res).toEqual({ ok: true, value: { jobId: "gid://shopify/Job/1", jobDone: false } });
    const call = shop.calls.find((c) => c.op === "CleanCopyUpsert")!;
    expect(call.variables).toEqual({
      themeId: copyId,
      files: [{ filename: file.filename, body: { type: "TEXT", value: file.content } }],
    });
  });

  it("allows only Liquid under layout/sections/snippets/templates/blocks", () => {
    expect(isAllowedFixPath("blocks/x.liquid")).toBe(true);
    expect(isAllowedFixPath("templates/product.liquid")).toBe(true);
    expect(isAllowedFixPath("templates/product.json")).toBe(false);
  });
});

describe("error mapping (typed, never raw GraphQL errors)", () => {
  it("ACCESS_DENIED from a GraphQL error code", async () => {
    shop.overrides.CleanCopyDuplicate = () => ({
      errors: [
        { message: "Access denied for themeDuplicate", extensions: { code: "ACCESS_DENIED" } },
      ],
    });
    expect(await admin.duplicateTheme(MAIN_ID, "n")).toMatchObject({
      ok: false,
      error: "ACCESS_DENIED",
    });
  });

  it("ACCESS_DENIED from a thrown client error message", async () => {
    shop.overrides.CleanCopyMain = () => new Error("Access denied for themes field.");
    expect(await admin.getMainTheme()).toMatchObject({ ok: false, error: "ACCESS_DENIED" });
  });

  it("an access-denied userError is ACCESS_DENIED; other userErrors are USER_ERROR", async () => {
    shop.overrides.CleanCopyDuplicate = () => ({
      data: {
        themeDuplicate: {
          newTheme: null,
          userErrors: [{ code: "ACCESS_DENIED", field: null, message: "x" }],
        },
      },
    });
    expect(await admin.duplicateTheme(MAIN_ID, "n")).toMatchObject({ error: "ACCESS_DENIED" });
    shop.overrides.CleanCopyDuplicate = () => ({
      data: {
        themeDuplicate: {
          newTheme: null,
          userErrors: [{ code: "THEME_LIMIT", field: null, message: "too many themes" }],
        },
      },
    });
    expect(await admin.duplicateTheme(MAIN_ID, "n")).toMatchObject({
      ok: false,
      error: "USER_ERROR",
      message: "userErrors: THEME_LIMIT",
    });
  });

  it("network errors and THROTTLED are TRANSIENT", async () => {
    shop.overrides.CleanCopyTheme = () => new Error("ECONNRESET");
    expect(await admin.getTheme(MAIN_ID)).toMatchObject({ ok: false, error: "TRANSIENT" });
    shop.overrides.CleanCopyTheme = () => ({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    });
    expect(await admin.getTheme(MAIN_ID)).toMatchObject({ ok: false, error: "TRANSIENT" });
  });

  it("never carries GraphQL message text (which can echo file bodies) in its message", async () => {
    const copyId = await readyCopy();
    shop.overrides.CleanCopyUpsert = () => ({
      errors: [{ message: `Variable $files invalid: ${BODY_MARKER}`, extensions: {} }],
    });
    const a = await admin.upsertFiles({ themeId: copyId, sourceThemeId: MAIN_ID, files: [file] });
    shop.overrides.CleanCopyUpsert = () => ({
      data: {
        themeFilesUpsert: {
          job: null,
          userErrors: [
            { code: "INVALID", field: ["files"], message: `Liquid error near ${BODY_MARKER}` },
          ],
        },
      },
    });
    const b = await admin.upsertFiles({ themeId: copyId, sourceThemeId: MAIN_ID, files: [file] });
    shop.overrides.CleanCopyUpsert = () => new Error(`boom ${BODY_MARKER}`);
    const c = await admin.upsertFiles({ themeId: copyId, sourceThemeId: MAIN_ID, files: [file] });
    for (const res of [a, b, c]) {
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain(BODY_MARKER);
    }
  });
});

describe("reads", () => {
  it("finds an UNPUBLISHED theme by exact name only", async () => {
    await readyCopy("Dawn - clean copy abc");
    expect((await admin.findUnpublishedThemeByName("Dawn - clean copy ab")).ok).toBe(true);
    const miss = await admin.findUnpublishedThemeByName("Dawn - clean copy ab");
    expect(miss).toEqual({ ok: true, value: null });
    const hit = await admin.findUnpublishedThemeByName("Dawn - clean copy abc");
    expect(hit.ok && hit.value?.name).toBe("Dawn - clean copy abc");
  });

  it("never adopts a MAIN theme even when the API filter returns it", async () => {
    shop.overrides.CleanCopyThemesByName = () => ({
      data: {
        themes: {
          nodes: [
            { id: MAIN_ID, name: "Dawn", role: "MAIN", processing: false, processingFailed: false },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    expect(await admin.findUnpublishedThemeByName("Dawn")).toEqual({ ok: true, value: null });
  });

  it("reads files with checksum and text content; an empty request makes no call", async () => {
    const res = await admin.readFiles(MAIN_ID, ["layout/theme.liquid", "missing.liquid"]);
    expect(res.ok && res.value).toEqual([
      expect.objectContaining({
        filename: "layout/theme.liquid",
        content: THEME_FILES["layout/theme.liquid"],
      }),
    ]);
    expect(await admin.readFiles(MAIN_ID, [])).toEqual({ ok: true, value: [] });
    expect(shop.count("CleanCopyFiles")).toBe(1);
  });

  it("reads the MAIN theme and job state", async () => {
    const main = await admin.getMainTheme();
    expect(main.ok && main.value).toMatchObject({ id: MAIN_ID, role: "MAIN" });
    shop.jobPollsUntilDone = 1;
    expect(await admin.getJob("gid://shopify/Job/1")).toEqual({ ok: true, value: { done: true } });
  });
});

describe("no forbidden mutations anywhere in the clean-copy code", () => {
  it.each([
    "app/services/clean-copy-admin.server.ts",
    "app/services/clean-copy.server.ts",
    "inngest/functions/clean-copy.ts",
  ])(
    "%s never names themePublish / themeDelete / themeFilesDelete / themeFilesCopy / themeCreate / themeUpdate",
    (path) => {
      const code = readFileSync(join(__dirname, "..", "..", path), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toMatch(
        /themePublish|themeDelete|themeFilesDelete|themeFilesCopy|themeCreate|themeUpdate/,
      );
    },
  );
});
