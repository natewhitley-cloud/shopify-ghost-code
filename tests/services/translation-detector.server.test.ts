import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  hasInstalledTranslationApp,
  detectOrphanedTranslations,
} from "../../app/services/translation-detector.server";
import type { TranslationAuditResult } from "../../app/services/translation-fetcher.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditResult(overrides: Partial<TranslationAuditResult> = {}): TranslationAuditResult {
  return {
    locales: [
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "fr", name: "French", primary: false, published: true },
    ],
    summaries: [],
    totalTranslations: 0,
    totalOutdated: 0,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<TranslationAuditResult["summaries"][0]> = {}) {
  return {
    locale: "fr",
    localeName: "French",
    resourceType: "PRODUCT",
    translatedCount: 5,
    outdatedCount: 0,
    sampleTranslations: [
      { resourceId: "gid://shopify/Product/1", key: "title", value: "Titre", outdated: false },
      {
        resourceId: "gid://shopify/Product/1",
        key: "body_html",
        value: "Description du produit",
        outdated: false,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hasInstalledTranslationApp
// ---------------------------------------------------------------------------

describe("hasInstalledTranslationApp", () => {
  it("returns true when Transcy is installed", () => {
    expect(hasInstalledTranslationApp(["Transcy: AI Language Translate"])).toBe(true);
  });

  it('returns true when "Translate & Adapt" is installed (case-insensitive)', () => {
    expect(hasInstalledTranslationApp(["translate & adapt"])).toBe(true);
  });

  it("returns true when Weglot is installed among other apps", () => {
    expect(hasInstalledTranslationApp(["Klaviyo", "Weglot Translate", "Loox"])).toBe(true);
  });

  it("returns false when no translation app installed", () => {
    expect(hasInstalledTranslationApp(["Klaviyo", "Loox", "Judge.me"])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasInstalledTranslationApp([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectOrphanedTranslations
// ---------------------------------------------------------------------------

describe("detectOrphanedTranslations", () => {
  it("returns findings when translations exist but no translation app installed", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary()],
      totalTranslations: 5,
    });

    const findings = detectOrphanedTranslations(audit, ["Klaviyo", "Loox"]);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TRANSLATION);
    expect(findings[0].filename).toBe("translations/fr/product");
    expect(findings[0].lineNumber).toBe(0);
    expect(findings[0].description).toContain("5 orphaned translations");
    expect(findings[0].description).toContain("French (fr)");
    expect(findings[0].description).toContain("product resources");
    expect(findings[0].description).toContain("no translation app is currently installed");
  });

  it("returns empty when a translation app is installed", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary()],
      totalTranslations: 5,
    });

    const findings = detectOrphanedTranslations(audit, ["Transcy: AI Language Translate"]);

    expect(findings).toEqual([]);
  });

  it("returns empty when no translations exist", () => {
    const audit = makeAuditResult({
      summaries: [],
      totalTranslations: 0,
    });

    const findings = detectOrphanedTranslations(audit, []);

    expect(findings).toEqual([]);
  });

  it("includes outdated count in description", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary({ outdatedCount: 3 })],
      totalTranslations: 5,
    });

    const findings = detectOrphanedTranslations(audit, []);

    expect(findings[0].description).toContain("(3 outdated)");
  });

  it("uses MEDIUM severity", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary()],
      totalTranslations: 5,
    });

    const findings = detectOrphanedTranslations(audit, []);

    expect(findings[0].severity).toBe(Severity.MEDIUM);
  });

  it("generates one finding per locale+resourceType combination", () => {
    const audit = makeAuditResult({
      summaries: [
        makeSummary({ locale: "fr", localeName: "French", resourceType: "PRODUCT" }),
        makeSummary({ locale: "fr", localeName: "French", resourceType: "COLLECTION" }),
        makeSummary({ locale: "de", localeName: "German", resourceType: "PRODUCT" }),
      ],
      totalTranslations: 15,
    });

    const findings = detectOrphanedTranslations(audit, []);

    expect(findings).toHaveLength(3);
    expect(findings[0].filename).toBe("translations/fr/product");
    expect(findings[1].filename).toBe("translations/fr/collection");
    expect(findings[2].filename).toBe("translations/de/product");
  });

  it("includes sample translations in code snippet", () => {
    const audit = makeAuditResult({
      summaries: [
        makeSummary({
          sampleTranslations: [
            {
              resourceId: "gid://shopify/Product/1",
              key: "title",
              value: "Titre",
              outdated: false,
            },
            {
              resourceId: "gid://shopify/Product/1",
              key: "body_html",
              value: "Description",
              outdated: true,
            },
          ],
        }),
      ],
      totalTranslations: 5,
    });

    const findings = detectOrphanedTranslations(audit, []);

    expect(findings[0].codeSnippet).toContain('title: "Titre"');
    expect(findings[0].codeSnippet).toContain('body_html: "Description" [outdated]');
  });

  it("skips summaries with zero translated count", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary({ translatedCount: 0 }), makeSummary({ translatedCount: 3 })],
      totalTranslations: 3,
    });

    const findings = detectOrphanedTranslations(audit, []);

    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("3 orphaned translations");
  });
});
