/**
 * Clean copy orchestration logic (gc-tib slice 4).
 *
 * The merchant selects fixable findings; we duplicate the MAIN theme and
 * remove exactly those spans in the unpublished copy. We never write MAIN and
 * never publish (spike D2): the merchant previews and publishes the copy.
 *
 *   preflightCleanCopy  every gate before a FixRun exists (typed refusals)
 *   requestCleanCopy    preflight -> createFixRun -> send clean-copy/requested
 *   ensureCopyTheme     worker step: duplicate MAIN once (adopting a copy made
 *                       by a crashed attempt, by its unique name)
 *   checkCopyReady      worker step: one processing poll of the copy
 *   writeCleanCopy      worker step: per-file drift guard + splice + upsert +
 *                       post-read (spike §3 steps 2-6)
 *
 * Failure model for the worker steps: a run-ending problem marks the run (and
 * its pending items) failed and throws CleanCopyFailure (the worker stops; on
 * ACCESS_DENIED it also refuses retries). Anything transient throws a plain
 * Error so Inngest retries the step; every step is safe to re-run.
 */

import { createHash } from "node:crypto";

import { parseLiveAppHooks } from "./app-removal.server";
import {
  type AdminResult,
  canvasThemeRefusal,
  type CleanCopyAdmin,
  isAllowedFixPath,
  MAX_FILES_PER_REQUEST,
  type ThemeInfo,
} from "./clean-copy-admin.server";
import { isFindingIgnored } from "./finding-aggregation.server";
import { isCleanCopyEnabled } from "./soft-launch-flags.server";
import { inngest } from "../../inngest/client";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import { PLANS } from "../lib/plans";
import { FIXABLE_FINDING_TYPES, nonCodeRanges, removalSpanFor } from "../lib/removal-span";
import { createSpanCrossCheck } from "../lib/span-crosscheck.server";
import { isScanStaleAfterThemeChange } from "../lib/stale-results";
import { spliceSpans } from "../lib/theme-splice";
import {
  ACTIVE_FIX_RUN_STATUSES,
  createFixRun,
  decideFixItems,
  type FixItemInput,
  type FixRunWithItems,
  getFixRunWithItems,
  isFixRunActive,
  type ItemDecision,
  markDoNotPublishIfWritten,
  markFixRunFailed,
  recordExpectedPostMd5,
  setFixRunActiveStatus,
  setFixRunCopyName,
  setFixRunCopyTheme,
  setFixRunDoNotPublish,
} from "../models/fix-run.server";
import { getIgnoredFindingsForShop } from "../models/ignored-finding.server";
import { getScanManifest } from "../models/scan-manifest.server";
import { SUCCESSFUL_SCAN_STATUSES } from "../models/scan.server";

export const WRITE_THEMES_SCOPE = "write_themes";
/** Upper bound on one selection (ids come from a form post). */
export const MAX_SELECTED_FINDINGS = 500;

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type RunRefusal =
  | "FLAG_OFF"
  | "EMPTY_SELECTION"
  | "SHOP_NOT_FOUND"
  | "NOT_PROFESSIONAL"
  | "SCOPE_MISSING"
  | "SCAN_NOT_FOUND"
  /** Not the latest successful scan of the current MAIN, or MAIN changed since. */
  | "SCAN_STALE"
  | "NO_MAIN_THEME"
  | "ACCESS_DENIED"
  | "ADMIN_UNAVAILABLE"
  | "MANIFEST_MISSING"
  /** The scan did not observe which apps have an enabled embed (D5 cannot be checked). */
  | "EMBED_STATUS_UNKNOWN"
  | "TOO_MANY_FILES"
  /** More than MAX_SELECTED_FINDINGS ids (bounds the query on untrusted input). */
  | "TOO_MANY_FINDINGS"
  /** One or more selected findings refused; see `findings`. */
  | "FINDINGS_REFUSED"
  /** D9: Canvas themes are not supported yet (canvasThemeRefusal). */
  | "CANVAS_THEME";

export type FindingRefusal =
  | "NOT_IN_SCAN"
  | "NOT_FIXABLE_TYPE"
  | "NO_SPAN"
  | "PATH_NOT_ALLOWED"
  | "IGNORED"
  /** No app attributed, so the merchant cannot confirm it is uninstalled. */
  | "APP_UNKNOWN"
  | "APP_HAS_LIVE_EMBED"
  | "APP_NOT_CONFIRMED"
  | "MANIFEST_MD5_MISSING";

/** Why a finding can't go in a clean copy, known without reading a file. */
export type FindingBlockReason =
  | "NOT_FIXABLE_TYPE"
  | "NO_SPAN"
  | "PATH_NOT_ALLOWED"
  | "IGNORED"
  | "APP_UNKNOWN"
  | "APP_HAS_LIVE_EMBED";

/**
 * The one rule chain for "can this finding be removed", shared by preflight,
 * the select page and the scan page's count (gc-tib.10). Null = removable so
 * far (preflight still checks the app confirmation and the manifest).
 */
export function findingBlockReason(
  f: {
    findingType: string;
    filename: string;
    appName: string | null;
    spanStart: number | null;
    spanEnd: number | null;
    spanSha256: string | null;
  } & Parameters<typeof isFindingIgnored>[0],
  ignores: Parameters<typeof isFindingIgnored>[1],
  embedApps: ReadonlySet<string>,
): FindingBlockReason | null {
  if (!(FIXABLE_FINDING_TYPES as readonly string[]).includes(f.findingType)) {
    return "NOT_FIXABLE_TYPE";
  }
  if (f.spanStart === null || f.spanEnd === null || f.spanSha256 === null) return "NO_SPAN";
  if (!isAllowedFixPath(f.filename)) return "PATH_NOT_ALLOWED";
  if (isFindingIgnored(f, ignores)) return "IGNORED";
  if (!f.appName) return "APP_UNKNOWN";
  if (embedApps.has(f.appName)) return "APP_HAS_LIVE_EMBED";
  return null;
}

type BlockableFinding = Parameters<typeof findingBlockReason>[0];

/**
 * What the select page offers before it reads any file, shared with the scan
 * page's count (gc-tib.21 audit): each finding's block reason, then the first
 * MAX_FILES_PER_REQUEST files (sorted) that hold a removable finding, and how
 * many more files were left out. The select page then checks file contents;
 * the scan page can only drop files with no scan-time md5.
 */
export function offerableCleanCopyFiles<F extends BlockableFinding>(
  findings: readonly F[],
  ignores: Parameters<typeof findingBlockReason>[1],
  embedApps: ReadonlySet<string>,
): {
  drafts: Array<{ finding: F; blocked: FindingBlockReason | null }>;
  shownFiles: string[];
  omittedFiles: number;
} {
  const drafts = findings.map((finding) => ({
    finding,
    blocked: findingBlockReason(finding, ignores, embedApps),
  }));
  const files = [
    ...new Set(drafts.filter((d) => !d.blocked).map((d) => d.finding.filename)),
  ].sort();
  return {
    drafts,
    shownFiles: files.slice(0, MAX_FILES_PER_REQUEST),
    omittedFiles: Math.max(0, files.length - MAX_FILES_PER_REQUEST),
  };
}

export type PreflightResult =
  | {
      ok: true;
      scanId: string;
      sourceThemeId: string;
      sourceThemeName: string;
      items: FixItemInput[];
    }
  | {
      ok: false;
      reason: RunRefusal;
      findings?: Array<{ findingId: string; reason: FindingRefusal }>;
    };

export type PreflightInput = {
  shopId: string;
  scanId: string;
  findingIds: readonly string[];
  /** App names the merchant ticked "I've uninstalled X" for (D5). */
  confirmedApps: readonly string[];
  /** Access scopes granted to this installation (e.g. session.scope split). */
  grantedScopes: readonly string[];
  admin: CleanCopyAdmin;
};

export { canvasThemeRefusal };

export type FreshnessRefusal =
  | "SCAN_STALE"
  | "ACCESS_DENIED"
  | "ADMIN_UNAVAILABLE"
  | "NO_MAIN_THEME"
  | "CANVAS_THEME";

export type FreshnessScan = {
  id: string;
  themeId: string;
  status: string;
  completedAt: Date | null;
};

/**
 * The one definition of "this scan may feed a clean copy" (audit M-i), shared
 * by preflight and the selection page: the scan succeeded, it is the LATEST
 * successful scan of its theme, no theme was published after it, its theme is
 * the current MAIN, MAIN has not changed since the scan completed, and MAIN is
 * not a Canvas theme (D9 hook). Returns MAIN on success.
 */
export async function checkCleanCopyFreshness(input: {
  shopId: string;
  lastThemePublishAt: Date | string | null;
  scan: FreshnessScan;
  admin: CleanCopyAdmin;
}): Promise<{ ok: true; main: ThemeInfo } | { ok: false; reason: FreshnessRefusal }> {
  const { scan } = input;
  if (!(SUCCESSFUL_SCAN_STATUSES as readonly string[]).includes(scan.status) || !scan.completedAt) {
    return { ok: false, reason: "SCAN_STALE" };
  }
  const latest = await db.scan.findFirst({
    where: {
      shopId: input.shopId,
      themeId: scan.themeId,
      status: { in: [...SUCCESSFUL_SCAN_STATUSES] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (
    latest?.id !== scan.id ||
    isScanStaleAfterThemeChange({
      autoRescan: false,
      lastThemePublishAt: input.lastThemePublishAt,
      scan,
    })
  ) {
    return { ok: false, reason: "SCAN_STALE" };
  }
  const mainRes = await input.admin.getMainTheme();
  if (!mainRes.ok) {
    return {
      ok: false,
      reason: mainRes.error === "ACCESS_DENIED" ? "ACCESS_DENIED" : "ADMIN_UNAVAILABLE",
    };
  }
  const main = mainRes.value;
  if (!main) return { ok: false, reason: "NO_MAIN_THEME" };
  if (main.id !== scan.themeId || (main.updatedAt !== null && main.updatedAt > scan.completedAt)) {
    return { ok: false, reason: "SCAN_STALE" };
  }
  const canvas = canvasThemeRefusal(main);
  if (canvas !== null) return { ok: false, reason: canvas };
  return { ok: true, main };
}

export async function preflightCleanCopy(input: PreflightInput): Promise<PreflightResult> {
  const shop = await db.shop.findUnique({
    where: { id: input.shopId },
    select: { domain: true, plan: true, lastThemePublishAt: true },
  });
  if (!isCleanCopyEnabled(shop?.domain)) return { ok: false, reason: "FLAG_OFF" };
  const findingIds = [...new Set(input.findingIds)];
  if (findingIds.length === 0) return { ok: false, reason: "EMPTY_SELECTION" };
  if (findingIds.length > MAX_SELECTED_FINDINGS) return { ok: false, reason: "TOO_MANY_FINDINGS" };
  if (!shop) return { ok: false, reason: "SHOP_NOT_FOUND" };
  if (shop.plan !== PLANS.PROFESSIONAL) return { ok: false, reason: "NOT_PROFESSIONAL" };
  if (!input.grantedScopes.includes(WRITE_THEMES_SCOPE)) {
    return { ok: false, reason: "SCOPE_MISSING" };
  }

  const scan = await db.scan.findFirst({
    where: { id: input.scanId, shopId: input.shopId },
    select: { id: true, themeId: true, status: true, completedAt: true, liveAppHooks: true },
  });
  if (!scan) return { ok: false, reason: "SCAN_NOT_FOUND" };
  const fresh = await checkCleanCopyFreshness({
    shopId: input.shopId,
    lastThemePublishAt: shop.lastThemePublishAt,
    scan,
    admin: input.admin,
  });
  if (!fresh.ok) return { ok: false, reason: fresh.reason };
  const main = fresh.main;

  const manifest = await getScanManifest(scan.id);
  if (!manifest) return { ok: false, reason: "MANIFEST_MISSING" };
  const md5ByPath = new Map(manifest.entries.map((e) => [e[0], e[1]] as const));

  const embedApps = parseLiveAppHooks(scan.liveAppHooks)?.embed ?? null;
  if (embedApps === null) return { ok: false, reason: "EMBED_STATUS_UNKNOWN" };

  const [findings, ignores] = await Promise.all([
    db.finding.findMany({
      where: { id: { in: findingIds }, scanId: scan.id },
      select: {
        id: true,
        filename: true,
        lineNumber: true,
        codeSnippet: true,
        findingType: true,
        appName: true,
        spanStart: true,
        spanEnd: true,
        spanSha256: true,
      },
    }),
    getIgnoredFindingsForShop(input.shopId),
  ]);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const confirmed = new Set(input.confirmedApps);

  const refusals: Array<{ findingId: string; reason: FindingRefusal }> = [];
  const items: FixItemInput[] = [];
  for (const id of findingIds) {
    const f = byId.get(id);
    const refuse = (reason: FindingRefusal) => refusals.push({ findingId: id, reason });
    if (!f) {
      refuse("NOT_IN_SCAN");
      continue;
    }
    const preMd5 = md5ByPath.get(f.filename) ?? null;
    const blocked = findingBlockReason(f, ignores, embedApps);
    if (blocked) refuse(blocked);
    else if (!f.appName || !confirmed.has(f.appName)) refuse("APP_NOT_CONFIRMED");
    else if (!preMd5) refuse("MANIFEST_MD5_MISSING");
    // Never true here (findingBlockReason refused it); narrows the span types.
    else if (f.spanStart === null || f.spanEnd === null || f.spanSha256 === null) refuse("NO_SPAN");
    else {
      items.push({
        findingId: f.id,
        findingType: f.findingType,
        filename: f.filename,
        spanStart: f.spanStart,
        spanEnd: f.spanEnd,
        spanSha256: f.spanSha256,
        preMd5,
      });
    }
  }
  if (refusals.length > 0) return { ok: false, reason: "FINDINGS_REFUSED", findings: refusals };
  if (new Set(items.map((i) => i.filename)).size > MAX_FILES_PER_REQUEST) {
    return { ok: false, reason: "TOO_MANY_FILES" };
  }
  return {
    ok: true,
    scanId: scan.id,
    sourceThemeId: main.id,
    sourceThemeName: main.name,
    items,
  };
}

export type RequestCleanCopyResult =
  | { ok: true; runId: string }
  | Extract<PreflightResult, { ok: false }>
  | { ok: false; reason: "RUN_ACTIVE"; activeRunId: string }
  | { ok: false; reason: "DISPATCH_FAILED" };

/** Preflight, create the run, and start the worker. For the slice-5 UI action. */
export async function requestCleanCopy(input: PreflightInput): Promise<RequestCleanCopyResult> {
  const pre = await preflightCleanCopy(input);
  if (!pre.ok) return pre;
  const created = await createFixRun({
    shopId: input.shopId,
    scanId: pre.scanId,
    sourceThemeId: pre.sourceThemeId,
    items: pre.items,
  });
  if (!created.ok) return created;
  try {
    await inngest.send({
      name: "clean-copy/requested",
      data: { shopId: input.shopId, fixRunId: created.runId },
    });
  } catch (err) {
    // A run that never starts must not hold the shop's one active slot.
    await failRunQuietly(created.runId, "DISPATCH_FAILED");
    logger.error("clean-copy/requested dispatch failed", {
      shopId: input.shopId,
      fixRunId: created.runId,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
    return { ok: false, reason: "DISPATCH_FAILED" };
  }
  return { ok: true, runId: created.runId };
}

// ---------------------------------------------------------------------------
// Worker steps
// ---------------------------------------------------------------------------

/** The run ended (already marked failed). `reason` is FixRun.failureReason. */
export class CleanCopyFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`clean copy failed: ${reason}`);
    this.name = "CleanCopyFailure";
    this.reason = reason;
  }
}

async function failPendingItems(runId: string, reason: string): Promise<void> {
  await db.fixItem.updateMany({
    where: { fixRunId: runId, status: "pending" },
    data: { status: "failed", reasonCode: reason },
  });
}

/**
 * `nothingWritten`: the caller knows this attempt sent no write (the adapter
 * guard refused the upsert), or the copy is gone, so do-not-publish would be a
 * false claim (audit r3).
 */
type FailOpts = { nothingWritten?: boolean };

async function failRunQuietly(runId: string, reason: string, opts: FailOpts = {}): Promise<void> {
  await failPendingItems(runId, reason);
  await markFixRunFailed(runId, reason);
  // A write may have landed unverified before this failure, e.g. ACCESS_DENIED
  // on the post-read or a mixed-userErrors upsert (audit M-d, r2 gc-tib.16).
  if (!opts.nothingWritten && reason !== "COPY_MISSING") await markDoNotPublishIfWritten(runId);
}

/** Mark the run failed (if still active) and stop. */
async function failRun(runId: string, reason: string, opts: FailOpts = {}): Promise<never> {
  await failRunQuietly(runId, reason, opts);
  throw new CleanCopyFailure(reason);
}

/**
 * Unwrap an adapter result. ACCESS_DENIED and WRITE_REFUSED end the run;
 * TRANSIENT throws a plain Error (Inngest retries the step). USER_ERROR is
 * returned to the caller, which decides.
 */
async function unwrap<T>(
  runId: string,
  res: AdminResult<T>,
  what: string,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  if (res.ok) return res;
  if (res.error === "ACCESS_DENIED") return failRun(runId, "ACCESS_DENIED");
  if (res.error === "WRITE_REFUSED") return failRun(runId, "WRITE_REFUSED");
  // The adapter's message is codes only (no content), safe for Inngest.
  if (res.error === "TRANSIENT") throw new Error(`[clean-copy] ${what}: ${res.message}`);
  return { ok: false, message: res.message };
}

/**
 * Gates re-checked inside the worker (audit logic 11): the flag is still on
 * (globally or for this shop's domain) and the shop is still on Professional. A downgrade mid-run stops the run.
 */
export async function runGateFailure(run: {
  shopId: string;
}): Promise<"FLAG_OFF" | "NOT_PROFESSIONAL" | null> {
  const shop = await db.shop.findUnique({
    where: { id: run.shopId },
    select: { domain: true, plan: true },
  });
  if (!isCleanCopyEnabled(shop?.domain)) return "FLAG_OFF";
  if (shop?.plan !== PLANS.PROFESSIONAL) return "NOT_PROFESSIONAL";
  return null;
}

async function loadActiveRun(runId: string) {
  const run = await getFixRunWithItems(runId);
  if (!run || !(ACTIVE_FIX_RUN_STATUSES as readonly string[]).includes(run.status)) return null;
  return run;
}

/** Theme names stay short; the run id suffix makes the copy name unique. */
const MAX_THEME_NAME = 50;

export function copyThemeNameFor(sourceName: string, runId: string): string {
  const suffix = ` - clean copy ${runId.slice(-8)}`;
  const base =
    sourceName
      .trim()
      .slice(0, MAX_THEME_NAME - suffix.length)
      .trim() || "Theme";
  return `${base}${suffix}`;
}

/**
 * Make (or adopt) the run's unpublished copy of MAIN. Idempotent: a set
 * copyThemeId is returned as-is; otherwise the copy name is persisted BEFORE
 * the mutation, and an UNPUBLISHED theme already carrying it (a crash after
 * the mutation, before the DB write) is adopted instead of duplicating again.
 */
export async function ensureCopyTheme(
  admin: CleanCopyAdmin,
  runId: string,
  now: Date = new Date(),
): Promise<{ copyThemeId: string } | { skipped: true }> {
  const run = await loadActiveRun(runId);
  if (!run) return { skipped: true };
  const gate = await runGateFailure(run);
  if (gate) return failRun(runId, gate);
  if (run.copyThemeId) return { copyThemeId: run.copyThemeId };

  await setFixRunActiveStatus(runId, "duplicating");
  const main = await unwrap(runId, await admin.getMainTheme(), "read MAIN");
  if (!main.ok || !main.value || main.value.id !== run.sourceThemeId) {
    return failRun(runId, "SCAN_STALE");
  }

  const name = run.copyThemeName ?? copyThemeNameFor(main.value.name, run.id);
  if (!run.copyThemeName) await setFixRunCopyName(runId, name);

  const existing = await unwrap(runId, await admin.findUnpublishedThemeByName(name), "find copy");
  let copy: ThemeInfo | null = existing.ok ? existing.value : null;
  if (!copy) {
    const dup = await unwrap(
      runId,
      await admin.duplicateTheme(run.sourceThemeId, name),
      "duplicate",
    );
    if (!dup.ok) {
      logger.warn("clean-copy duplicate refused", { fixRunId: runId, message: dup.message });
      return failRun(runId, "DUPLICATE_FAILED");
    }
    copy = dup.value;
  }
  if (copy.id === run.sourceThemeId) return failRun(runId, "COPY_IS_SOURCE");
  await setFixRunCopyTheme(runId, { copyThemeId: copy.id, copyCreatedAt: now });
  return { copyThemeId: copy.id };
}

/**
 * One processing check of the copy. `final` = the last allowed check: a copy
 * still processing then fails the run DUPLICATE_TIMEOUT.
 */
export async function checkCopyReady(
  admin: CleanCopyAdmin,
  runId: string,
  copyThemeId: string,
  final: boolean,
): Promise<"ready" | "processing" | "skipped"> {
  const run = await loadActiveRun(runId);
  if (!run) return "skipped";
  const res = await unwrap(runId, await admin.getTheme(copyThemeId), "read copy");
  const theme = res.ok ? res.value : null;
  if (!theme) return failRun(runId, "COPY_MISSING");
  if (theme.processingFailed) return failRun(runId, "DUPLICATE_PROCESSING_FAILED");
  if (theme.processing) {
    if (final) return failRun(runId, "DUPLICATE_TIMEOUT");
    return "processing";
  }
  if (theme.role !== "UNPUBLISHED" || theme.id === run.sourceThemeId) {
    return failRun(runId, "COPY_NOT_UNPUBLISHED");
  }
  return "ready";
}

export type WriteOptions = {
  /** Job polls after the upsert before giving up (JOB_TIMEOUT). */
  jobPollAttempts?: number;
  jobPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type RunItem = FixRunWithItems["items"][number];

type PlannedWrite = {
  filename: string;
  content: string;
  preMd5: string;
  expectedMd5: string;
  itemIds: string[];
};

/**
 * The per-file drift guard and write (spike §3 steps 2-6), for every file
 * with pending items, in one upsert (<= 50 files). Safe to re-run: decided
 * items are skipped, and a file already at an item's recorded expected md5
 * is a write that landed before a crash (marked removed, not FILE_CHANGED).
 * A file whose items recorded an expected md5 but that is now at neither
 * that md5 nor the scanned one may hold an unverified write: POST_WRITE_MISMATCH
 * and do-not-publish (audit H1).
 */
export async function writeCleanCopy(
  admin: CleanCopyAdmin,
  runId: string,
  opts: WriteOptions = {},
): Promise<{ written: number } | { skipped: true }> {
  const run = await loadActiveRun(runId);
  if (!run) return { skipped: true };
  const gate = await runGateFailure(run);
  if (gate) return failRun(runId, gate);
  const copyThemeId = run.copyThemeId;
  if (!copyThemeId) return failRun(runId, "NO_COPY");
  if (copyThemeId === run.sourceThemeId) return failRun(runId, "COPY_IS_SOURCE");
  await setFixRunActiveStatus(runId, "writing");

  const byFile = new Map<string, RunItem[]>();
  for (const item of run.items) {
    if (item.status !== "pending") continue;
    byFile.set(item.filename, [...(byFile.get(item.filename) ?? []), item]);
  }
  if (byFile.size === 0) return { written: 0 };
  if (byFile.size > MAX_FILES_PER_REQUEST) return failRun(runId, "TOO_MANY_FILES");

  const pre = await unwrap(
    runId,
    await admin.readFiles(copyThemeId, [...byFile.keys()]),
    "pre-read",
  );
  const preFiles = new Map((pre.ok ? pre.value : []).map((f) => [f.filename, f]));

  const decisions: ItemDecision[] = [];
  const writes: PlannedWrite[] = [];
  let unverifiedWrite = false;
  const decideAll = (items: RunItem[], status: ItemDecision["status"], reasonCode: string) =>
    items.forEach((i) => decisions.push({ itemId: i.id, status, reasonCode }));

  for (const [filename, items] of byFile) {
    const file = preFiles.get(filename) ?? null;
    const checksum = file?.checksumMd5 ?? null;
    const preMd5 = items[0].preMd5;

    // Crash-retry: an expected md5 was recorded, so an upsert may have run.
    const recorded = items.filter((i) => i.postMd5 !== null);
    if (recorded.length > 0) {
      if (checksum !== null && checksum === recorded[0].postMd5) {
        // The write landed before its items were marked.
        for (const i of items) {
          decisions.push(
            i.postMd5 === checksum
              ? { itemId: i.id, status: "removed", reasonCode: null }
              : { itemId: i.id, status: "skipped", reasonCode: "FILE_CHANGED" },
          );
        }
        continue;
      }
      if (checksum === null || checksum !== preMd5) {
        // Neither the scanned file nor our result: unverified (audit H1).
        decideAll(items, "failed", "POST_WRITE_MISMATCH");
        unverifiedWrite = true;
        continue;
      }
      // Still the scanned file: the upsert never landed. Write it normally.
    }

    if (!file || file.content === null || checksum === null) {
      decideAll(items, "skipped", "FILE_CHANGED");
      continue;
    }
    if (!preMd5 || items.some((i) => i.preMd5 !== preMd5) || checksum !== preMd5) {
      decideAll(items, "skipped", "FILE_CHANGED");
      continue;
    }
    const content = file.content;
    if (md5(content) !== checksum) {
      decideAll(items, "skipped", "CHECKSUM_UNVERIFIABLE");
      continue;
    }

    // A throw while checking one file (guard, cross-check, splice) refuses
    // that file only; the other files are still written (audit r6 L3).
    const mark = decisions.length;
    try {
      const ranges = nonCodeRanges(content);
      // One parse5 parse per file, on the first span (gc-t44r 3A).
      const crossCheck = createSpanCrossCheck(content);
      const located: RunItem[] = [];
      for (const item of items) {
        if (
          !item.findingType ||
          !(FIXABLE_FINDING_TYPES as readonly string[]).includes(item.findingType)
        ) {
          decisions.push({ itemId: item.id, status: "skipped", reasonCode: "NOT_FIXABLE_TYPE" });
          continue;
        }
        const hashOk =
          item.spanStart >= 0 &&
          item.spanEnd <= content.length &&
          item.spanStart < item.spanEnd &&
          sha256(content.slice(item.spanStart, item.spanEnd)) === item.spanSha256;
        const span = hashOk
          ? removalSpanFor(item.findingType, content, item.spanStart, ranges)
          : null;
        if (!span?.ok || span.span.start !== item.spanStart || span.span.end !== item.spanEnd) {
          decisions.push({ itemId: item.id, status: "skipped", reasonCode: "SPAN_MISMATCH" });
          continue;
        }
        const confirmed = crossCheck(item.findingType, span.span);
        if (!confirmed.ok) {
          decisions.push({
            itemId: item.id,
            status: "skipped",
            reasonCode: `VALIDATION_FAILED:${confirmed.reason}`,
          });
          continue;
        }
        located.push(item);
      }

      const spliced = spliceSpans(
        content,
        located.map((i) => ({ start: i.spanStart, end: i.spanEnd })),
      );
      const accepted: RunItem[] = [];
      for (const item of located) {
        const refusal = spliced.refused.find(
          (r) => r.span.start === item.spanStart && r.span.end === item.spanEnd,
        );
        if (refusal) {
          decisions.push({
            itemId: item.id,
            status: "skipped",
            reasonCode: `VALIDATION_FAILED:${refusal.reason}`,
          });
        } else {
          accepted.push(item);
        }
      }
      if (accepted.length === 0) continue;
      writes.push({
        filename,
        content: spliced.content,
        preMd5,
        expectedMd5: md5(spliced.content),
        itemIds: accepted.map((i) => i.id),
      });
    } catch (error) {
      decisions.length = mark;
      decideAll(items, "skipped", "VALIDATION_FAILED:PARSER_DISAGREES");
      logger.warn("clean-copy-file-check-failed", {
        runId,
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (unverifiedWrite) await setFixRunDoNotPublish(runId);
  await decideFixItems(runId, decisions);
  if (writes.length === 0) return { written: 0 };
  // An earlier attempt of this step already sent an upsert (its job may still
  // land), so a refusal now can't claim nothing was written (audit r4).
  const earlierAttemptWrote = run.items.some((i) => i.postMd5 !== null);
  for (const w of writes) await recordExpectedPostMd5(runId, w.itemIds, w.expectedMd5);

  // The run may have been failed (STALE sweep, onFailure) since we loaded it
  // (audit sec 7): never write for a run that is no longer active.
  if (!(await isFixRunActive(runId))) return { skipped: true };

  const upRes = await admin.upsertFiles({
    themeId: copyThemeId,
    sourceThemeId: run.sourceThemeId,
    files: writes.map((w) => ({ filename: w.filename, content: w.content })),
  });
  // The guard refused before sending anything: this attempt wrote nothing.
  if (!upRes.ok && upRes.error === "WRITE_REFUSED") {
    // A deleted copy is COPY_MISSING, never "delete the copy" (audit r4).
    const copy = await admin.getTheme(copyThemeId);
    if (copy.ok && copy.value === null) return failRun(runId, "COPY_MISSING");
    return failRun(runId, "WRITE_REFUSED", { nothingWritten: !earlierAttemptWrote });
  }
  const up = await unwrap(runId, upRes, "upsert");
  const userErrors = up.ok ? up.value.userErrors : [{ filename: null, code: "UNKNOWN" }];
  if (userErrors.length > 0) {
    logger.warn("clean-copy upsert userErrors", {
      fixRunId: runId,
      codes: userErrors.map((e) => e.code),
    });
  }
  const failedFile = (filename: string) =>
    userErrors.some((e) => e.filename === null || e.filename === filename);

  /**
   * The copy's role now. MAIN: the merchant published it mid-write (audit M-a).
   * GONE: deleted. OTHER: any other role. Only MAIN is "published" (r2 gc-tib.14).
   */
  const copyRole = async (): Promise<"UNPUBLISHED" | "MAIN" | "GONE" | "OTHER"> => {
    const t = await unwrap(runId, await admin.getTheme(copyThemeId), "read copy role");
    if (!t.ok) throw new Error(`[clean-copy] read copy role: ${t.message}`);
    if (t.value === null) return "GONE";
    if (t.value.role === "UNPUBLISHED" || t.value.role === "MAIN") return t.value.role;
    return "OTHER";
  };

  // Always wait for a returned job, userErrors or not (audit M-e).
  let jobTimedOut = false;
  let role: Awaited<ReturnType<typeof copyRole>> = "UNPUBLISHED";
  if (up.ok && !up.value.jobDone && up.value.jobId) {
    const attempts = opts.jobPollAttempts ?? 10;
    const delay = opts.jobPollDelayMs ?? 1500;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    jobTimedOut = true;
    for (let i = 0; i < attempts; i++) {
      await sleep(delay);
      role = await copyRole();
      if (role !== "UNPUBLISHED") break;
      const job = await unwrap(runId, await admin.getJob(up.value.jobId), "job");
      if (job.ok && job.value.done) {
        jobTimedOut = false;
        break;
      }
    }
  }
  if (role === "UNPUBLISHED") role = await copyRole();
  // Deleted or moved to another role: stop; failRun flags do-not-publish.
  if (role === "GONE") return failRun(runId, "COPY_MISSING");
  if (role === "OTHER") return failRun(runId, "COPY_NOT_UNPUBLISHED");

  if (role === "MAIN") {
    // The copy went live while we were writing: nothing we wrote is verified.
    await setFixRunDoNotPublish(runId);
    await decideFixItems(
      runId,
      writes.flatMap((w) =>
        w.itemIds.map((itemId) => ({
          itemId,
          status: "failed" as const,
          reasonCode: "COPY_PUBLISHED_DURING_WRITE",
        })),
      ),
    );
    return failRun(runId, "COPY_PUBLISHED_DURING_WRITE");
  }

  // Post-read: the file's checksum is the truth, whatever the upsert said.
  const post = await unwrap(
    runId,
    await admin.readFiles(
      copyThemeId,
      writes.map((w) => w.filename),
    ),
    "post-read",
  );
  const postFiles = new Map((post.ok ? post.value : []).map((f) => [f.filename, f]));
  const outcomes: ItemDecision[] = [];
  let doNotPublish = false;
  for (const w of writes) {
    const now = postFiles.get(w.filename)?.checksumMd5 ?? null;
    let status: ItemDecision["status"] = "failed";
    let reasonCode: string | null;
    if (now === w.expectedMd5) {
      status = "removed";
      reasonCode = null;
    } else if (now === w.preMd5 && failedFile(w.filename) && !jobTimedOut) {
      reasonCode = "UPSERT_FAILED";
    } else if (now === w.preMd5 && jobTimedOut) {
      // The job may still change the copy after we stop looking (audit M-f).
      reasonCode = "JOB_TIMEOUT";
      doNotPublish = true;
    } else {
      reasonCode = "POST_WRITE_MISMATCH";
      doNotPublish = true;
    }
    for (const itemId of w.itemIds) outcomes.push({ itemId, status, reasonCode });
  }
  if (doNotPublish) await setFixRunDoNotPublish(runId);
  await decideFixItems(runId, outcomes);
  return { written: writes.length };
}
