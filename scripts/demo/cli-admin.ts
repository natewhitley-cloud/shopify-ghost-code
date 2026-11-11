/**
 * DEMO ONLY (gc-tib.7): a CleanCopyAdmin backed by the Shopify CLI, which acts
 * with the store staff member's own login. Used to record the clean-copy flow
 * on a development store before Shopify grants the app write_themes. The app
 * itself always uses createCleanCopyAdmin (Admin GraphQL).
 *
 * Same write guard as the real adapter: never the source theme, only an
 * UNPUBLISHED theme that is not processing, only allowed fix paths, 1..50
 * files. `theme push` always gets --nodelete and never --allow-live.
 * checksumMd5 is computed locally from the pulled body (the CLI does not
 * expose Shopify's checksum), so the md5 cross-check is not exercised here.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  AdminResult,
  CleanCopyAdmin,
  ThemeInfo,
} from "../../app/services/clean-copy-admin.server";

/** The real adapter's guard helpers, passed in (a static import would cycle with test mocks). */
export type GuardHelpers = {
  isAllowedFixPath: (f: string) => boolean;
  MAX_FILES_PER_REQUEST: number;
};

const GID = "gid://shopify/OnlineStoreTheme/";
const toGid = (n: number | string) => `${GID}${n}`;
const toNum = (gid: string) => {
  if (!gid.startsWith(GID) || !/^\d+$/.test(gid.slice(GID.length)))
    throw new Error(`bad gid ${gid}`);
  return gid.slice(GID.length);
};
const md5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");
const fail = (error: "WRITE_REFUSED" | "TRANSIENT" | "USER_ERROR", message: string) =>
  ({ ok: false, error, message }) as const;

type CliTheme = { id: number; name: string; role: string; processing: boolean };

export function createCliCleanCopyAdmin(
  store: string,
  { isAllowedFixPath, MAX_FILES_PER_REQUEST }: GuardHelpers,
  workDir = mkdtempSync(join(tmpdir(), "gc-cli-")),
): CleanCopyAdmin & { calls: string[] } {
  const calls: string[] = [];
  const cli = (args: string[], timeoutMs = 300_000): string => {
    if (args.includes("--allow-live") || args.includes("-a"))
      throw new Error("refusing --allow-live");
    calls.push(args.slice(0, 2).join(" "));
    return execFileSync("shopify", [...args, "--store", store], {
      input: "",
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  const list = (): CliTheme[] => JSON.parse(cli(["theme", "list", "--json"]));
  const info = (t: CliTheme): ThemeInfo => ({
    id: toGid(t.id),
    name: t.name,
    role: t.role === "live" ? "MAIN" : t.role.toUpperCase(),
    processing: t.processing,
    processingFailed: false,
    updatedAt: null,
  });
  const getTheme = async (themeId: string): Promise<AdminResult<ThemeInfo | null>> => {
    const t = list().find((x) => toGid(x.id) === themeId);
    return { ok: true, value: t ? info(t) : null };
  };
  let n = 0;
  return {
    calls,
    async getMainTheme() {
      const t = list().find((x) => x.role === "live");
      return { ok: true, value: t ? info(t) : null };
    },
    getTheme,
    async findUnpublishedThemeByName(name) {
      const t = list().find((x) => x.name === name && x.role === "unpublished");
      return { ok: true, value: t ? info(t) : null };
    },
    async duplicateTheme(sourceThemeId, name) {
      const out = JSON.parse(
        cli([
          "theme",
          "duplicate",
          "--theme",
          toNum(sourceThemeId),
          "--name",
          name,
          "--json",
          "--force",
        ]),
      ) as { theme?: { id: number; name: string; role: string } };
      if (!out.theme) return fail("USER_ERROR", "duplicate returned no theme");
      return { ok: true, value: info({ ...out.theme, processing: false }) };
    },
    async readFiles(themeId, filenames) {
      const dir = join(workDir, `pull-${++n}`);
      mkdirSync(dir, { recursive: true });
      cli([
        "theme",
        "pull",
        "--theme",
        toNum(themeId),
        "--path",
        dir,
        ...filenames.flatMap((f) => ["--only", f]),
      ]);
      return {
        ok: true,
        value: filenames.map((filename) => {
          const p = join(dir, filename);
          if (!existsSync(p)) return { filename, checksumMd5: null, content: null };
          const content = readFileSync(p, "utf8");
          return { filename, checksumMd5: md5(content), content };
        }),
      };
    },
    async upsertFiles({ themeId, sourceThemeId, files }) {
      // ---- same HARD GUARD as createCleanCopyAdmin ----
      if (themeId === sourceThemeId) return fail("WRITE_REFUSED", "target is the source theme");
      if (files.length === 0 || files.length > MAX_FILES_PER_REQUEST)
        return fail("WRITE_REFUSED", "file count");
      if (files.some((f) => !isAllowedFixPath(f.filename)))
        return fail("WRITE_REFUSED", "path not allowed");
      const target = await getTheme(themeId);
      if (!target.ok || !target.value) return fail("WRITE_REFUSED", "target theme not found");
      if (target.value.role !== "UNPUBLISHED" || target.value.processing) {
        return fail("WRITE_REFUSED", `target role is ${target.value.role}`);
      }
      // ---- end guard ----
      const dir = join(workDir, `push-${++n}`);
      for (const f of files) {
        const p = join(dir, f.filename);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.content);
      }
      cli([
        "theme",
        "push",
        "--theme",
        toNum(themeId),
        "--path",
        dir,
        "--nodelete",
        "--json",
        ...files.flatMap((f) => ["--only", f.filename]),
      ]);
      return { ok: true, value: { jobId: null, jobDone: true, userErrors: [] } };
    },
    async getJob() {
      return { ok: true, value: { done: true } };
    },
    // The CLI acts as store staff, not the app: there is no installation grant
    // to read. The demo passes grantedScopes to preflight itself.
    async getGrantedScopes() {
      return fail("USER_ERROR", "the CLI demo has no app installation");
    },
  };
}
