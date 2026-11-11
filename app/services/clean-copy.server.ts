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
  type CleanCopyAdmin,
  isAllowedFixPath,
  MAX_FILES_PER_REQUEST,
  type ThemeInfo,
} from "./clean-copy-admin.server";
import { fingerprintFinding } from "./scan-differ.server";
import { isCleanCopyEnabled } from "./soft-launch-flags.server";
import { inngest } from "../../inngest/client";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import { PLANS } from "../lib/plans";
import { FIXABLE_FINDING_TYPES, nonCodeRanges, removalSpanFor } from "../lib/removal-span";
import { isScanStaleAfterThemeChange } from "../lib/stale-results";
import { spliceSpans } from "../lib/theme-splice";
import {
  ACTIVE_FIX_RUN_STATUSES,
  createFixRun,
  decideFixItems,
  type FixItemInput,
  type FixRunWithItems,
  getFixRunWithItems,
  type ItemDecision,
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
  | "FINDINGS_REFUSED";

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

/**
 * TODO(gc-dg5e) D9: Canvas themes are excluded from v1, but there is no
 * reliable Canvas signal yet. When gc-dg5e reports one, return "CANVAS_THEME"
 * here (and add it to RunRefusal). Until then this hook refuses nothing.
 */
export function canvasThemeRefusal(main: ThemeInfo): null {
  void main;
  return null;
}

export async function preflightCleanCopy(input: PreflightInput): Promise<PreflightResult> {
  if (!isCleanCopyEnabled()) return { ok: false, reason: "FLAG_OFF" };
  const findingIds = [...new Set(input.findingIds)];
  if (findingIds.length === 0) return { ok: false, reason: "EMPTY_SELECTION" };
  if (findingIds.length > MAX_SELECTED_FINDINGS) return { ok: false, reason: "TOO_MANY_FINDINGS" };

  const shop = await db.shop.findUnique({
    where: { id: input.shopId },
    select: { plan: true, lastThemePublishAt: true },
  });
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
    !(SUCCESSFUL_SCAN_STATUSES as readonly string[]).includes(scan.status) ||
    !scan.completedAt ||
    latest?.id !== scan.id ||
    isScanStaleAfterThemeChange({
      autoRescan: false,
      lastThemePublishAt: shop.lastThemePublishAt,
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
  canvasThemeRefusal(main);

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
  const fixable = new Set<string>(FIXABLE_FINDING_TYPES);

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
    if (!fixable.has(f.findingType)) refuse("NOT_FIXABLE_TYPE");
    else if (f.spanStart === null || f.spanEnd === null || f.spanSha256 === null) refuse("NO_SPAN");
    else if (!isAllowedFixPath(f.filename)) refuse("PATH_NOT_ALLOWED");
    else if (
      ignores.fingerprints.has(
        fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber),
      ) ||
      (f.appName !== null && ignores.appNames.has(f.appName))
    )
      refuse("IGNORED");
    else if (!f.appName) refuse("APP_UNKNOWN");
    else if (embedApps.has(f.appName)) refuse("APP_HAS_LIVE_EMBED");
    else if (!confirmed.has(f.appName)) refuse("APP_NOT_CONFIRMED");
    else if (!preMd5) refuse("MANIFEST_MD5_MISSING");
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

async function failRunQuietly(runId: string, reason: string): Promise<void> {
  await failPendingItems(runId, reason);
  await markFixRunFailed(runId, reason);
}

/** Mark the run failed (if still active) and stop. */
async function failRun(runId: string, reason: string): Promise<never> {
  await failRunQuietly(runId, reason);
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
  if (!isCleanCopyEnabled()) return failRun(runId, "FLAG_OFF");
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
 */
export async function writeCleanCopy(
  admin: CleanCopyAdmin,
  runId: string,
  opts: WriteOptions = {},
): Promise<{ written: number } | { skipped: true }> {
  const run = await loadActiveRun(runId);
  if (!run) return { skipped: true };
  if (!isCleanCopyEnabled()) return failRun(runId, "FLAG_OFF");
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
  const decideAll = (items: RunItem[], status: ItemDecision["status"], reasonCode: string) =>
    items.forEach((i) => decisions.push({ itemId: i.id, status, reasonCode }));

  for (const [filename, items] of byFile) {
    const file = preFiles.get(filename);
    if (!file || file.content === null || file.checksumMd5 === null) {
      decideAll(items, "skipped", "FILE_CHANGED");
      continue;
    }

    // Crash-retry: the write landed before its items were marked.
    const recorded = items.filter((i) => i.postMd5 !== null);
    if (recorded.length > 0 && file.checksumMd5 === recorded[0].postMd5) {
      for (const i of items) {
        if (i.postMd5 === file.checksumMd5) {
          decisions.push({ itemId: i.id, status: "removed", reasonCode: null });
        } else {
          decisions.push({ itemId: i.id, status: "skipped", reasonCode: "FILE_CHANGED" });
        }
      }
      continue;
    }

    const preMd5 = items[0].preMd5;
    if (!preMd5 || items.some((i) => i.preMd5 !== preMd5) || file.checksumMd5 !== preMd5) {
      decideAll(items, "skipped", "FILE_CHANGED");
      continue;
    }
    const content = file.content;
    if (md5(content) !== file.checksumMd5) {
      decideAll(items, "skipped", "CHECKSUM_UNVERIFIABLE");
      continue;
    }

    const ranges = nonCodeRanges(content);
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
  }

  await decideFixItems(runId, decisions);
  if (writes.length === 0) return { written: 0 };
  for (const w of writes) await recordExpectedPostMd5(runId, w.itemIds, w.expectedMd5);

  const up = await unwrap(
    runId,
    await admin.upsertFiles({
      themeId: copyThemeId,
      sourceThemeId: run.sourceThemeId,
      files: writes.map((w) => ({ filename: w.filename, content: w.content })),
    }),
    "upsert",
  );
  const upsertFailed = !up.ok;
  if (!up.ok) logger.warn("clean-copy upsert userErrors", { fixRunId: runId, message: up.message });

  let jobTimedOut = false;
  if (up.ok && !up.value.jobDone && up.value.jobId) {
    const attempts = opts.jobPollAttempts ?? 10;
    const delay = opts.jobPollDelayMs ?? 1500;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    jobTimedOut = true;
    for (let i = 0; i < attempts; i++) {
      await sleep(delay);
      const job = await unwrap(runId, await admin.getJob(up.value.jobId), "job");
      if (job.ok && job.value.done) {
        jobTimedOut = false;
        break;
      }
    }
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
  let mismatch = false;
  for (const w of writes) {
    const now = postFiles.get(w.filename)?.checksumMd5 ?? null;
    let status: ItemDecision["status"] = "failed";
    let reasonCode: string | null;
    if (now === w.expectedMd5) {
      status = "removed";
      reasonCode = null;
    } else if (now === w.preMd5 && upsertFailed) {
      reasonCode = "UPSERT_FAILED";
    } else if (now === w.preMd5 && jobTimedOut) {
      reasonCode = "JOB_TIMEOUT";
    } else {
      reasonCode = "POST_WRITE_MISMATCH";
      mismatch = true;
    }
    for (const itemId of w.itemIds) outcomes.push({ itemId, status, reasonCode });
  }
  if (mismatch) await setFixRunDoNotPublish(runId);
  await decideFixItems(runId, outcomes);
  return { written: writes.length };
}
