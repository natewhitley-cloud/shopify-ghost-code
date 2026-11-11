/**
 * DEMO ONLY (gc-tib.7): run the real clean-copy service end to end on the dev
 * store, with a LOCAL database and the CLI-backed admin. Writes nothing to
 * the live theme: the guard allows writes only to the unpublished copy.
 *
 *   DATABASE_URL=postgresql://<me>@localhost:5432/ghostcode_cleancopy_demo \
 *   CLEAN_COPY_ENABLED=true DEMO_STORE=nw-dev-store-2.myshopify.com \
 *   npx vite-node --config vitest.config.ts scripts/demo/run-demo.ts
 *
 * Writes .cache/demo/last-run.json (gitignored), read by the preview harness.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createCliCleanCopyAdmin } from "./cli-admin";
import db from "../../app/db.server";
import { FIXABLE_FINDING_TYPES } from "../../app/lib/removal-span";
import { createFixRun, finalizeFixRun, getFixRunWithItems } from "../../app/models/fix-run.server";
import { upsertScanManifest } from "../../app/models/scan-manifest.server";
import {
  isAllowedFixPath,
  MAX_FILES_PER_REQUEST,
} from "../../app/services/clean-copy-admin.server";
import {
  checkCopyReady,
  ensureCopyTheme,
  preflightCleanCopy,
  writeCleanCopy,
} from "../../app/services/clean-copy.server";
import { observedEmbedApps, scanThemeFiles } from "../../app/services/scan-engine.server";

const DB = process.env.DATABASE_URL ?? "";
const STORE = process.env.DEMO_STORE ?? "";
if (!/@localhost:5432\/ghostcode_cleancopy_demo$/.test(DB))
  throw new Error("DATABASE_URL must be the local demo DB");
if (STORE !== "nw-dev-store-2.myshopify.com")
  throw new Error("DEMO_STORE must be nw-dev-store-2.myshopify.com");
if (process.env.CLEAN_COPY_ENABLED !== "true") throw new Error("set CLEAN_COPY_ENABLED=true");

const md5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const admin = createCliCleanCopyAdmin(STORE, { isAllowedFixPath, MAX_FILES_PER_REQUEST });
  const mainRes = await admin.getMainTheme();
  if (!mainRes.ok || !mainRes.value) throw new Error("no MAIN theme");
  const mainTheme = mainRes.value;
  log("MAIN theme", mainTheme.name, mainTheme.id);

  // 1. Pull MAIN and scan it with the real scan engine (what the app's scan does).
  const dir = mkdtempSync(join(tmpdir(), "gc-main-"));
  execFileSync(
    "shopify",
    ["theme", "pull", "--theme", mainTheme.id.split("/").pop()!, "--path", dir, "--store", STORE],
    { input: "", stdio: ["pipe", "ignore", "ignore"], timeout: 300_000 },
  );
  const files = walk(dir)
    .filter((p) => /\.(liquid|json|js|css)$/.test(p))
    .map((p) => ({ filename: relative(dir, p), content: readFileSync(p, "utf8") }));
  const { findings } = scanThemeFiles(files);
  const embedApps = observedEmbedApps(files);
  log(
    "scanned",
    files.length,
    "files,",
    findings.length,
    "findings; apps with a live embed:",
    embedApps,
  );

  // 2. Seed the local DB: Professional shop, completed scan, findings, manifest.
  const shop = await db.shop.upsert({
    where: { domain: STORE },
    create: { domain: STORE, plan: "Professional" },
    update: { plan: "Professional", lastThemePublishAt: null },
  });
  await db.fixRun.updateMany({
    where: { shopId: shop.id, status: { in: ["pending", "duplicating", "writing"] } },
    data: { status: "failed", failureReason: "DEMO_RESET" },
  });
  const scan = await db.scan.create({
    data: {
      shopId: shop.id,
      themeId: mainTheme.id,
      themeName: mainTheme.name,
      status: "COMPLETED",
      startedAt: new Date(),
      completedAt: new Date(),
      findingCount: findings.length,
      liveAppHooks: { embedApps, scriptTagApps: null },
    },
  });
  await db.finding.createMany({ data: findings.map((f) => ({ ...f, scanId: scan.id })) });
  await upsertScanManifest(scan.id, {
    shopId: shop.id,
    themeId: mainTheme.id,
    entries: files.map((f) => [f.filename, md5(f.content), f.content.length, null, null]) as never,
    appBlocks: null,
  });

  // 3. The merchant's selection: every removable finding; confirm each app.
  const stored = await db.finding.findMany({
    where: {
      scanId: scan.id,
      findingType: { in: [...FIXABLE_FINDING_TYPES] },
      spanStart: { not: null },
    },
  });
  const selectable = stored.filter((f) => f.appName && !(embedApps ?? []).includes(f.appName));
  const confirmedApps = [...new Set(selectable.map((f) => f.appName!))];
  log("selected", selectable.length, "findings from", confirmedApps.join(", "));

  // 4. The real service: preflight, create run, duplicate, wait, write, finalize.
  const pre = await preflightCleanCopy({
    shopId: shop.id,
    scanId: scan.id,
    findingIds: selectable.map((f) => f.id),
    confirmedApps,
    grantedScopes: ["read_themes", "write_themes"],
    admin,
  });
  if (!pre.ok) throw new Error(`preflight refused: ${JSON.stringify(pre)}`);
  const created = await createFixRun({
    shopId: shop.id,
    scanId: pre.scanId,
    sourceThemeId: pre.sourceThemeId,
    items: pre.items,
  });
  if (!created.ok) throw new Error(`create refused: ${JSON.stringify(created)}`);
  const runId = created.runId;
  log("run", runId);
  const dup = await ensureCopyTheme(admin, runId);
  log("copy", dup);
  if (!("copyThemeId" in dup)) throw new Error("no copy");
  for (let i = 0; i < 20; i++) {
    const r = await checkCopyReady(admin, runId, dup.copyThemeId, i === 19);
    log("copy status", r);
    if (r === "ready") break;
    await new Promise((res) => setTimeout(res, 10_000));
  }
  const written = await writeCleanCopy(admin, runId);
  log("write", written);
  const fin = await finalizeFixRun(runId);
  log("final", fin);
  const run = await getFixRunWithItems(runId);
  mkdirSync(join(process.cwd(), ".cache/demo"), { recursive: true });
  writeFileSync(
    join(process.cwd(), ".cache/demo/last-run.json"),
    JSON.stringify(
      { shopDomain: STORE, scanId: scan.id, mainTheme, run, cliCalls: admin.calls },
      null,
      2,
    ),
  );
  log(
    "items",
    run?.items.map((i) => `${i.status} ${i.filename} ${i.reasonCode ?? ""}`),
  );
  log("CLI calls", admin.calls);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
