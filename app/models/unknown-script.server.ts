import type { SignatureSubmission, SubmissionStatus } from "@prisma/client";

import db from "../db.server";
import { hostnameFromUrl } from "../lib/url.server";

export type CreateUnknownScriptInput = {
  filename: string;
  lineNumber: number;
  url: string;
  resourceType: "script" | "stylesheet";
  codeSnippet: string;
};

export type DomainSubmissionGroup = {
  domain: string;
  submissionCount: number;
  suggestedNames: Array<{ name: string; count: number }>;
  sampleUrls: string[];
};

export type SubmissionStats = {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
};

/**
 * A single submission enriched with its unknown-script context, for the admin
 * review table (per-submission approve/reject moderation).
 */
export type SubmissionReviewRow = {
  id: string;
  suggestedAppName: string;
  status: SubmissionStatus;
  createdAt: Date;
  reviewedAt: Date | null;
  url: string;
  filename: string;
  domain: string | null;
};

/**
 * Upper bound on rows returned by the submission-review queries. These power an
 * internal ops tool, so a fixed cap is preferable to unbounded reads; the newest
 * submissions are the ones worth reviewing. Raise if the review backlog ever
 * legitimately exceeds this.
 */
export const SUBMISSION_QUERY_LIMIT = 500;

/**
 * Batch-insert unknown scripts for a completed scan.
 *
 * Idempotency guard:
 *   This runs inside the single `fetch-and-scan` Inngest step. Inngest re-runs
 *   the whole step on retry, so a bare createMany would insert a second copy of
 *   every row if the step retried after this write committed. Mirroring
 *   saveThemeFindings, a deleteMany is issued before createMany inside a
 *   $transaction: a retry deletes any previously-created rows and re-inserts
 *   them, producing the same final state instead of duplicates.
 *
 *   The deleteMany runs unconditionally (even for empty input) so that a retry
 *   carrying fewer/zero scripts than a prior partial attempt still clears stale
 *   rows. This is safe because unknown scripts are only ever written here during
 *   the scan step, before any merchant SignatureSubmission can exist — so the
 *   `onDelete: Cascade` from SignatureSubmission -> UnknownScript never wipes
 *   real submission data in practice.
 */
export async function createUnknownScripts(scanId: string, scripts: CreateUnknownScriptInput[]) {
  return db.$transaction(async (tx) => {
    // Idempotency guard: clear any rows from a previous partial attempt.
    await tx.unknownScript.deleteMany({ where: { scanId } });

    if (scripts.length === 0) {
      return { count: 0 };
    }

    return tx.unknownScript.createMany({
      data: scripts.map((s) => ({ ...s, scanId, domain: hostnameFromUrl(s.url) })),
    });
  });
}

/**
 * Get unknown scripts for a scan, including any merchant submissions.
 */
export async function getUnknownScriptsForScan(scanId: string) {
  return db.unknownScript.findMany({
    where: { scanId },
    include: { submissions: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Submit a merchant's identification of which app left an unknown script.
 */
export async function submitSignatureSuggestion(
  unknownScriptId: string,
  shopId: string,
  suggestedAppName: string,
) {
  return db.signatureSubmission.create({
    data: {
      unknownScriptId,
      shopId,
      suggestedAppName,
    },
  });
}

/**
 * List submissions grouped by URL domain with frequency counts.
 * Returns domains with the most submissions first.
 */
export async function getSubmissionsByDomain(options?: {
  status?: SubmissionStatus;
  minCount?: number;
}): Promise<DomainSubmissionGroup[]> {
  const statusFilter = options?.status;
  const minCount = options?.minCount ?? 1;

  const submissions = await db.signatureSubmission.findMany({
    where: statusFilter ? { status: statusFilter } : undefined,
    include: {
      unknownScript: {
        select: { url: true },
      },
    },
    // Bound the read: this is an internal review query, not a merchant surface.
    // Group over the newest SUBMISSION_QUERY_LIMIT submissions rather than the
    // full (potentially unbounded) table.
    orderBy: { createdAt: "desc" },
    take: SUBMISSION_QUERY_LIMIT,
  });

  // Group by domain
  const domainMap = new Map<
    string,
    {
      nameCounts: Map<string, number>;
      urls: Set<string>;
      count: number;
    }
  >();

  for (const sub of submissions) {
    const domain = hostnameFromUrl(sub.unknownScript.url);
    if (!domain) continue;

    let entry = domainMap.get(domain);
    if (!entry) {
      entry = { nameCounts: new Map(), urls: new Set(), count: 0 };
      domainMap.set(domain, entry);
    }

    entry.count += 1;
    entry.urls.add(sub.unknownScript.url);
    entry.nameCounts.set(
      sub.suggestedAppName,
      (entry.nameCounts.get(sub.suggestedAppName) ?? 0) + 1,
    );
  }

  // Convert to output format, filter by minCount, sort by count descending
  const results: DomainSubmissionGroup[] = [];

  for (const [domain, entry] of domainMap) {
    if (entry.count < minCount) continue;

    const suggestedNames = Array.from(entry.nameCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const sampleUrls = Array.from(entry.urls).slice(0, 3);

    results.push({
      domain,
      submissionCount: entry.count,
      suggestedNames,
      sampleUrls,
    });
  }

  results.sort((a, b) => b.submissionCount - a.submissionCount);

  return results;
}

/**
 * Update the status of a submission (ACCEPTED, REJECTED).
 * Sets reviewedAt to current timestamp.
 */
export async function updateSubmissionStatus(
  submissionId: string,
  status: "ACCEPTED" | "REJECTED",
): Promise<SignatureSubmission> {
  return db.signatureSubmission.update({
    where: { id: submissionId },
    data: {
      status,
      reviewedAt: new Date(),
    },
  });
}

/**
 * Batch-update status for all submissions matching a URL domain.
 * Used after promoting a domain to the signature DB.
 */
export async function acceptSubmissionsForDomain(domain: string): Promise<{ count: number }> {
  // Fast path: exact-match on the indexed `domain` column (populated at insert
  // in createUnknownScripts). No substring scan, no JS refine — the stored
  // hostname is already exact.
  const indexedScripts = await db.unknownScript.findMany({
    where: { domain },
    select: { id: true },
  });

  // Legacy fallback: rows created before the `domain` column existed have
  // domain=null. Match them with the old non-indexable `contains` substring
  // scan, scoped to domain=null rows so it never touches already-indexed rows,
  // then refine in JS for an exact hostname match ("example.com" must not match
  // "notexample.com"). This set shrinks over time — createUnknownScripts
  // repopulates `domain` whenever a scan is re-run.
  // TODO(gc-06e.10): once historical UnknownScript rows are backfilled with
  // `domain`, drop this fallback and the JS refine entirely.
  const legacyScripts = await db.unknownScript.findMany({
    where: { domain: null, url: { contains: domain } },
    select: { id: true, url: true },
  });
  const legacyScriptIds = legacyScripts
    .filter((s) => hostnameFromUrl(s.url) === domain)
    .map((s) => s.id);

  const matchingScriptIds = [...indexedScripts.map((s) => s.id), ...legacyScriptIds];

  if (matchingScriptIds.length === 0) {
    return { count: 0 };
  }

  return db.signatureSubmission.updateMany({
    where: {
      unknownScriptId: { in: matchingScriptIds },
    },
    data: {
      status: "ACCEPTED",
      reviewedAt: new Date(),
    },
  });
}

/**
 * List individual submissions (newest first, bounded) enriched with their
 * unknown-script context, for the admin review table's per-submission
 * approve/reject moderation.
 */
export async function listSubmissionsForReview(options?: {
  status?: SubmissionStatus;
}): Promise<SubmissionReviewRow[]> {
  const rows = await db.signatureSubmission.findMany({
    where: options?.status ? { status: options.status } : undefined,
    include: {
      unknownScript: {
        select: { url: true, filename: true, domain: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: SUBMISSION_QUERY_LIMIT,
  });

  return rows.map((r) => ({
    id: r.id,
    suggestedAppName: r.suggestedAppName,
    status: r.status,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
    url: r.unknownScript.url,
    filename: r.unknownScript.filename,
    domain: r.unknownScript.domain,
  }));
}

/**
 * Find an unknown script by ID, scoped to a specific shop.
 * Returns null if not found or not owned by the shop.
 */
export async function findUnknownScriptForShop(unknownScriptId: string, shopId: string) {
  return db.unknownScript.findFirst({
    where: { id: unknownScriptId, scan: { shopId } },
  });
}

/**
 * Get total submission counts for dashboard metrics.
 */
export async function getSubmissionStats(): Promise<SubmissionStats> {
  const [total, pending, accepted, rejected] = await Promise.all([
    db.signatureSubmission.count(),
    db.signatureSubmission.count({ where: { status: "PENDING" } }),
    db.signatureSubmission.count({ where: { status: "ACCEPTED" } }),
    db.signatureSubmission.count({ where: { status: "REJECTED" } }),
  ]);

  return { total, pending, accepted, rejected };
}
