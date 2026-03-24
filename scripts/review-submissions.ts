/**
 * CLI script to review signature submissions grouped by domain.
 *
 * Usage:
 *   npx tsx scripts/review-submissions.ts
 *   npx tsx scripts/review-submissions.ts --min-count=3
 *   npx tsx scripts/review-submissions.ts --status=ACCEPTED
 *   npx tsx scripts/review-submissions.ts --min-count=2 --status=PENDING
 */

import { PrismaClient, SubmissionStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// We import the model functions but they use `db.server` which relies on the
// app's singleton. For standalone scripts, we set up a fresh PrismaClient and
// monkey-patch the module. Instead, we import the functions directly since
// they already import db internally.
// ---------------------------------------------------------------------------
import { getSubmissionsByDomain, getSubmissionStats } from "../app/models/unknown-script.server";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { minCount: number; status?: SubmissionStatus } {
  const args = process.argv.slice(2);
  let minCount = 1;
  let status: SubmissionStatus | undefined;

  for (const arg of args) {
    if (arg.startsWith("--min-count=")) {
      const val = parseInt(arg.split("=")[1], 10);
      if (isNaN(val) || val < 1) {
        console.error(`Invalid --min-count value: ${arg.split("=")[1]}`);
        process.exit(1);
      }
      minCount = val;
    } else if (arg.startsWith("--status=")) {
      const val = arg.split("=")[1].toUpperCase();
      if (!["PENDING", "ACCEPTED", "REJECTED"].includes(val)) {
        console.error(`Invalid --status value: ${val}. Must be PENDING, ACCEPTED, or REJECTED.`);
        process.exit(1);
      }
      status = val as SubmissionStatus;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx scripts/review-submissions.ts [options]

Options:
  --min-count=N     Minimum submissions per domain (default: 1)
  --status=STATUS   Filter by status: PENDING, ACCEPTED, REJECTED (default: PENDING)
  --help, -h        Show this help message`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}. Use --help for usage.`);
      process.exit(1);
    }
  }

  return { minCount, status };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function padRight(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + " ".repeat(len - str.length);
}

function formatTable(domains: Awaited<ReturnType<typeof getSubmissionsByDomain>>): void {
  if (domains.length === 0) {
    console.log("  No submissions match the given filters.\n");
    return;
  }

  // Header
  console.log(
    `  ${padRight("Domain", 40)} ${padRight("Count", 8)} ${padRight("Top Suggested Names", 35)} Sample URLs`,
  );
  console.log(`  ${"-".repeat(40)} ${"-".repeat(8)} ${"-".repeat(35)} ${"-".repeat(40)}`);

  for (const group of domains) {
    const topNames = group.suggestedNames
      .slice(0, 3)
      .map((n) => `${n.name} (${n.count})`)
      .join(", ");

    const sampleUrl = group.sampleUrls[0] ?? "";

    console.log(
      `  ${padRight(group.domain, 40)} ${padRight(String(group.submissionCount), 8)} ${padRight(topNames, 35)} ${sampleUrl}`,
    );

    // Additional sample URLs on subsequent lines
    for (const url of group.sampleUrls.slice(1)) {
      console.log(`  ${" ".repeat(40)} ${" ".repeat(8)} ${" ".repeat(35)} ${url}`);
    }
  }
  console.log();
}

function generateSignatureTemplates(
  domains: Awaited<ReturnType<typeof getSubmissionsByDomain>>,
): void {
  const candidates = domains.filter((d) => {
    // At least 2 submissions agreeing on the same app name
    return d.suggestedNames.some((n) => n.count >= 2);
  });

  if (candidates.length === 0) {
    console.log("  No domains with 2+ submissions agreeing on an app name.\n");
    return;
  }

  console.log("Ready-to-paste AppSignature templates:\n");

  for (const group of candidates) {
    // Use the top suggested name (most agreed-upon)
    const topName = group.suggestedNames[0];

    console.log(
      `  // ${group.domain} — ${group.submissionCount} submissions, ${topName.count} agree on "${topName.name}"`,
    );
    console.log(`  {`);
    console.log(`    appName: "${topName.name}",`);
    console.log(`    cdnDomains: ["${group.domain}"],`);
    console.log(`    scriptPatterns: [],`);
    console.log(`    snippetNames: [],`);
    console.log(`    cssPatterns: [],`);
    console.log(`  },\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { minCount, status } = parseArgs();

  console.log("\n=== Signature Submission Review ===\n");

  // Stats
  const stats = await getSubmissionStats();
  console.log("Overall Stats:");
  console.log(`  Total:    ${stats.total}`);
  console.log(`  Pending:  ${stats.pending}`);
  console.log(`  Accepted: ${stats.accepted}`);
  console.log(`  Rejected: ${stats.rejected}`);
  console.log();

  // Domain breakdown
  const filterDesc = [status ? `status=${status}` : "status=PENDING", `minCount=${minCount}`].join(
    ", ",
  );
  console.log(`Submissions by Domain (${filterDesc}):\n`);

  const domains = await getSubmissionsByDomain({
    status: status ?? "PENDING",
    minCount,
  });

  formatTable(domains);

  // Signature templates for high-confidence matches
  console.log("--- Signature Candidates ---\n");
  generateSignatureTemplates(domains);
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    // Disconnect the Prisma client used by db.server
    const prisma = new PrismaClient();
    await prisma.$disconnect();
  });
