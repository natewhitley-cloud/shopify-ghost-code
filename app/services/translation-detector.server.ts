/**
 * Translation detection logic.
 *
 * Converts translation audit results into Finding objects. This is the
 * equivalent of scan-engine for translations — it takes raw API data and
 * produces structured findings for the scan results.
 *
 * Detection strategy: if translations exist but no translation app is
 * currently installed, the translations are orphaned and flagged.
 */

import { FindingType } from "@prisma/client";

import { classifySeverity } from "./severity-classifier.server";
import type { TranslationAuditResult } from "./translation-fetcher.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Known translation apps
// ---------------------------------------------------------------------------

/** Known translation app names — used to cross-reference with installed apps. */
const TRANSLATION_APP_NAMES = [
  "Translate & Adapt",
  "Transcy",
  "Langify",
  "LangShop",
  "Weglot",
  "Hextom Translate",
  "T Lab",
  "Bablic",
  "ConveyThis",
  "GTranslate",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether any installed app is a known translation app.
 *
 * Uses case-insensitive substring matching so that variations like
 * "Transcy: AI Language Translate" still match.
 */
export function hasInstalledTranslationApp(installedAppNames: string[]): boolean {
  const lowerInstalled = installedAppNames.map((n) => n.toLowerCase());
  return TRANSLATION_APP_NAMES.some((name) =>
    lowerInstalled.some((installed) => installed.includes(name.toLowerCase())),
  );
}

/**
 * Convert a translation audit result into findings.
 *
 * Only generates findings if no translation app is currently installed —
 * if a translation app is present, the translations are presumably managed.
 *
 * Each locale with translations gets one finding summarizing the orphaned
 * translation data. Individual translations are not surfaced as separate
 * findings (too noisy — a store could have thousands).
 */
export function detectOrphanedTranslations(
  audit: TranslationAuditResult,
  installedAppNames: string[],
): CreateFindingInput[] {
  // If a translation app is installed, translations are actively managed — skip.
  if (hasInstalledTranslationApp(installedAppNames)) {
    return [];
  }

  const findings: CreateFindingInput[] = [];

  for (const summary of audit.summaries) {
    if (summary.translatedCount === 0) continue;

    const codeSnippet = summary.sampleTranslations
      .slice(0, 3)
      .map((t) => `${t.key}: "${t.value}"${t.outdated ? " [outdated]" : ""}`)
      .join("\n");

    const severity = classifySeverity(FindingType.GHOST_TRANSLATION, codeSnippet);

    const outdatedNote = summary.outdatedCount > 0 ? ` (${summary.outdatedCount} outdated)` : "";

    findings.push({
      filename: `translations/${summary.locale}/${summary.resourceType.toLowerCase()}`,
      lineNumber: 0,
      codeSnippet,
      findingType: FindingType.GHOST_TRANSLATION,
      severity,
      appName: undefined,
      description:
        `${summary.translatedCount} orphaned translations${outdatedNote} for ` +
        `${summary.localeName} (${summary.locale}) on ${summary.resourceType.toLowerCase()} ` +
        `resources — no translation app is currently installed`,
    });
  }

  return findings;
}
