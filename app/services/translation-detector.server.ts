/**
 * Translation detection logic.
 *
 * Converts translation audit results into Finding objects. This is the
 * equivalent of scan-engine for translations — it takes raw API data and
 * produces structured findings for the scan results.
 *
 * Framing: there is NO reliable way to prove translation content is genuinely
 * orphaned. Translations use Shopify-standard keys (not app namespaces),
 * disabled-locale translations are auto-deleted by Shopify, the Translation
 * object carries no provenance field, and translation apps (e.g. Translate &
 * Adapt) leave no theme artifacts. So we do NOT claim these are ghost code.
 * Instead each locale's translation content is surfaced as a LOW-severity
 * informational item for the merchant to review and confirm.
 */

import { FindingType } from "@prisma/client";

import { classifySeverity } from "./severity-classifier.server";
import type { TranslationAuditResult } from "./translation-fetcher.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a translation audit result into informational findings.
 *
 * Each locale+resourceType combination that has translation content gets one
 * finding summarizing what was found, so the merchant can review it. Individual
 * translations are not surfaced as separate findings (too noisy — a store could
 * have thousands).
 *
 * These findings are review prompts, not defect attributions: we cannot detect
 * whether translation content is genuinely orphaned, so we never assert that it
 * was left behind by an uninstalled app.
 */
export function detectTranslationContent(audit: TranslationAuditResult): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const summary of audit.summaries) {
    if (summary.translatedCount === 0) continue;

    const codeSnippet = summary.sampleTranslations
      .slice(0, 3)
      .map((t) => `${t.key}: "${t.value}"${t.outdated ? " [outdated]" : ""}`)
      .join("\n");

    const severity = classifySeverity(FindingType.GHOST_TRANSLATION, codeSnippet);

    const entryLabel = summary.translatedCount === 1 ? "entry" : "entries";
    const outdatedNote = summary.outdatedCount > 0 ? `, ${summary.outdatedCount} outdated` : "";

    findings.push({
      filename: `translations/${summary.locale}/${summary.resourceType.toLowerCase()}`,
      lineNumber: 0,
      codeSnippet,
      findingType: FindingType.GHOST_TRANSLATION,
      severity,
      appName: undefined,
      description:
        `Translation content found for ${summary.localeName} (${summary.locale}) on ` +
        `${summary.resourceType.toLowerCase()} resources — ${summary.translatedCount} ` +
        `${entryLabel}${outdatedNote}. Review and confirm this belongs to a translation app ` +
        `you still use; remove it if it was left behind by an app you no longer have installed.`,
    });
  }

  return findings;
}
