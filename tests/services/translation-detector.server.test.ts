import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { detectTranslationContent } from "../../app/services/translation-detector.server";
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

// Words that would frame the finding as a proven defect rather than a review
// prompt. The reframed copy (LOG-3) must not assert any of these as fact.
const ACCUSATORY_TERMS = [/orphan/i, /\bghost\b/i, /uninstalled/i];

// ---------------------------------------------------------------------------
// detectTranslationContent
// ---------------------------------------------------------------------------

describe("detectTranslationContent", () => {
  it("returns one informational finding per locale+resourceType with content", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary()],
      totalTranslations: 5,
    });

    const findings = detectTranslationContent(audit);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_TRANSLATION);
    expect(findings[0].filename).toBe("translations/fr/product");
    expect(findings[0].lineNumber).toBe(0);
    expect(findings[0].description).toContain("French (fr)");
    expect(findings[0].description).toContain("product resources");
    expect(findings[0].description).toContain("5 entries");
  });

  it("classifies translation findings as LOW severity (informational)", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary()],
      totalTranslations: 5,
    });

    const findings = detectTranslationContent(audit);

    expect(findings[0].severity).toBe(Severity.LOW);
  });

  it("frames the description as a review prompt, not an accusatory defect attribution", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary()],
      totalTranslations: 5,
    });

    const findings = detectTranslationContent(audit);
    const description = findings[0].description;

    // Must read as a review prompt the merchant can act on...
    expect(description).toMatch(/review/i);
    expect(description).toContain("Translation content found");
    // ...and must NOT assert that the content is orphaned/ghost/left by an
    // uninstalled app as established fact.
    for (const term of ACCUSATORY_TERMS) {
      expect(description).not.toMatch(term);
    }
  });

  it("returns empty when no translations exist", () => {
    const audit = makeAuditResult({
      summaries: [],
      totalTranslations: 0,
    });

    const findings = detectTranslationContent(audit);

    expect(findings).toEqual([]);
  });

  it("notes the outdated count in the description", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary({ outdatedCount: 3 })],
      totalTranslations: 5,
    });

    const findings = detectTranslationContent(audit);

    expect(findings[0].description).toContain("3 outdated");
  });

  it("uses singular 'entry' for a single translation", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary({ translatedCount: 1 })],
      totalTranslations: 1,
    });

    const findings = detectTranslationContent(audit);

    expect(findings[0].description).toContain("1 entry");
    expect(findings[0].description).not.toContain("1 entries");
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

    const findings = detectTranslationContent(audit);

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

    const findings = detectTranslationContent(audit);

    expect(findings[0].codeSnippet).toContain('title: "Titre"');
    expect(findings[0].codeSnippet).toContain('body_html: "Description" [outdated]');
  });

  it("skips summaries with zero translated count", () => {
    const audit = makeAuditResult({
      summaries: [makeSummary({ translatedCount: 0 }), makeSummary({ translatedCount: 3 })],
      totalTranslations: 3,
    });

    const findings = detectTranslationContent(audit);

    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("3 entries");
  });
});
