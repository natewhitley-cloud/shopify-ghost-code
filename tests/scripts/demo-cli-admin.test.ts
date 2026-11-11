/**
 * The demo CLI adapter (scripts/demo/cli-admin.ts, gc-tib.7) keeps the real
 * adapter's write guard: never the source theme, only an UNPUBLISHED theme
 * that is not processing, only allowed fix paths, 1..MAX files, and every
 * push is --nodelete without --allow-live. The Shopify CLI is mocked.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: exec }));

import {
  isAllowedFixPath,
  MAX_FILES_PER_REQUEST,
} from "../../app/services/clean-copy-admin.server";
import { createCliCleanCopyAdmin } from "../../scripts/demo/cli-admin";

const GID = "gid://shopify/OnlineStoreTheme/";
const themes = [
  { id: 1, name: "Live", role: "live", processing: false },
  { id: 2, name: "Copy", role: "unpublished", processing: false },
  { id: 3, name: "Busy", role: "unpublished", processing: true },
  { id: 4, name: "Dev", role: "development", processing: false },
  { id: 5, name: "NoFlag", role: "unpublished" },
];
const file = (filename = "layout/theme.liquid") => ({ filename, content: "x" });
const pushes = () =>
  exec.mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === "theme" && a[1] === "push");

let admin: ReturnType<typeof createCliCleanCopyAdmin>;

beforeEach(() => {
  exec
    .mockReset()
    .mockImplementation((_cmd: string, args: string[]) =>
      args[1] === "list" ? JSON.stringify(themes) : "{}",
    );
  admin = createCliCleanCopyAdmin(
    "demo.myshopify.com",
    { isAllowedFixPath, MAX_FILES_PER_REQUEST },
    mkdtempSync(join(tmpdir(), "gc-cli-test-")),
  );
});

const upsert = (themeId: string, files = [file()], sourceThemeId = `${GID}1`) =>
  admin.upsertFiles({ themeId, sourceThemeId, files });

describe("demo CLI adapter write guard", () => {
  it("refuses the source theme, MAIN, processing, other roles and missing themes", async () => {
    expect(await upsert(`${GID}2`, [file()], `${GID}2`)).toMatchObject({ error: "WRITE_REFUSED" });
    // 5: CLI output without a processing flag fails closed (r3).
    for (const id of [1, 3, 4, 5, 99]) {
      expect(await upsert(`${GID}${id}`)).toMatchObject({ ok: false, error: "WRITE_REFUSED" });
    }
    expect(pushes()).toHaveLength(0);
  });

  it("refuses zero files, too many files and paths outside the fix paths", async () => {
    expect(await upsert(`${GID}2`, [])).toMatchObject({ error: "WRITE_REFUSED" });
    const many = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) =>
      file(`snippets/s${i}.liquid`),
    );
    expect(await upsert(`${GID}2`, many)).toMatchObject({ error: "WRITE_REFUSED" });
    for (const bad of ["config/settings_data.json", "layout/../config/x.liquid"]) {
      expect(isAllowedFixPath(bad)).toBe(false);
      expect(await upsert(`${GID}2`, [file(bad)])).toMatchObject({ error: "WRITE_REFUSED" });
    }
    // The CLI reads --only as a glob (r3).
    for (const glob of ["snippets/*.liquid", "snippets/a?.liquid", "snippets/{a,b}.liquid"]) {
      expect(await upsert(`${GID}2`, [file(glob)])).toMatchObject({ error: "WRITE_REFUSED" });
    }
    expect(pushes()).toHaveLength(0);
  });

  it("pushes an allowed write to the unpublished copy only, with --nodelete and never --allow-live", async () => {
    expect(await upsert(`${GID}2`)).toEqual({
      ok: true,
      value: { jobId: null, jobDone: true, userErrors: [] },
    });
    const [args] = pushes();
    expect(args).toEqual(expect.arrayContaining(["--theme", "2", "--nodelete", "--only"]));
    expect(args).not.toContain("--allow-live");
    expect(args).not.toContain("-a");
    expect(exec.mock.calls.every((c) => (c[2] as { input?: string }).input === "")).toBe(true);
  });

  it("has no app installation scopes to report", async () => {
    expect(await admin.getGrantedScopes()).toMatchObject({ ok: false });
  });
});
