import type { SignatureSubmission, SubmissionStatus } from "@prisma/client";

import db from "../db.server";

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
      data: scripts.map((s) => ({ ...s, scanId })),
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
 * Extract domain from a URL string, returning null for invalid URLs.
 */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
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
    const domain = extractDomain(sub.unknownScript.url);
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
  // Filter at the DB level using a URL contains check on the domain.
  // This avoids fetching every unknown script into memory.
  const unknownScripts = await db.unknownScript.findMany({
    where: { url: { contains: domain } },
    select: { id: true, url: true },
  });

  // Refine in JS to ensure exact domain match (contains is a substring match,
  // so "example.com" would also match "notexample.com").
  const matchingScriptIds = unknownScripts
    .filter((s) => extractDomain(s.url) === domain)
    .map((s) => s.id);

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
