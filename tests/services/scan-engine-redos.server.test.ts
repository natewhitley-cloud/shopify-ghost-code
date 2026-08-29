/**
 * ReDoS-hardening + file-size-cap regression tests for scan-engine.server.ts
 * (gc-06e.2).
 *
 * Background: the tag detectors previously scanned whole-file content with
 * `<tag[^>]+ ... [^>]* ...>` regexes. Those adjacent `[^>]` quantifiers backtrack
 * quadratically from every `<tag` start, so a pathological theme file (thousands
 * of unterminated `<link`/`<meta`/`<script` fragments) could pin a CPU for
 * minutes. The detectors now isolate each tag with a linear indexOf pass before
 * applying the (unchanged) attribute regexes, so the same input completes in a
 * few milliseconds.
 *
 * These tests assert two things:
 *   1. Pathological input completes fast (the backtracking surface is gone).
 *   2. Detection is unchanged on normal fixtures (the hardening is behavior-
 *      preserving) — complementing the full detector suite in
 *      scan-engine.server.test.ts, all of which still pass unchanged.
 */

import { FindingType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  MAX_SCANNABLE_FILE_BYTES,
  collectUnknownScripts,
  collectUnknownStylesheets,
  detectDuplicateMetaTags,
  detectGhostCanonical,
  detectGhostHrefLang,
  detectGhostOg,
  detectGhostPreconnect,
  detectGhostRobots,
  detectGhostScripts,
  detectGhostStyles,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";

// A pathological input is a long run of an unterminated tag: many `<tag` start
// positions and no closing `>`. Kept under MAX_SCANNABLE_FILE_BYTES so the
// detectors actually run (rather than being size-capped) — this is what proves
// the regex itself no longer backtracks. Under the OLD whole-file regexes this
// same string took on the order of minutes; the hardened detectors finish in ms.
function pathological(fragment: string): string {
  // ~600 KB, comfortably under the 1 MB cap.
  const reps = Math.floor(600_000 / fragment.length);
  return fragment.repeat(reps);
}

// Generous ceiling: the hardened detectors complete in single-digit ms. The old
// quadratic behavior blew past this by orders of magnitude, so a few hundred ms
// cleanly separates "linear" from "backtracking" without CI flakiness.
const REDOS_BUDGET_MS = 400;

function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("scan-engine ReDoS hardening — pathological input completes fast", () => {
  const linkBomb: ThemeFile = {
    filename: "layout/theme.liquid",
    content: pathological('<link rel="stylesheet" href="//evil.example '),
  };
  const metaBomb: ThemeFile = {
    filename: "layout/theme.liquid",
    content: pathological('<meta name="robots" content="noindex '),
  };
  const scriptBomb: ThemeFile = {
    filename: "layout/theme.liquid",
    content: pathological('<script src="//evil.example/a '),
  };

  it("detectGhostStyles is fast on an unterminated <link> flood", () => {
    expect(timed(() => detectGhostStyles(linkBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectGhostCanonical is fast on an unterminated <link> flood", () => {
    expect(timed(() => detectGhostCanonical(linkBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectGhostPreconnect is fast on an unterminated <link> flood", () => {
    expect(timed(() => detectGhostPreconnect(linkBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectGhostHrefLang is fast on an unterminated <link> flood", () => {
    expect(timed(() => detectGhostHrefLang(linkBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("collectUnknownStylesheets is fast on an unterminated <link> flood", () => {
    expect(timed(() => collectUnknownStylesheets(linkBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectGhostRobots is fast on an unterminated <meta> flood", () => {
    expect(timed(() => detectGhostRobots(metaBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectDuplicateMetaTags is fast on an unterminated <meta> flood", () => {
    expect(timed(() => detectDuplicateMetaTags(metaBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectGhostOg is fast on an unterminated <meta> flood", () => {
    expect(timed(() => detectGhostOg(metaBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectGhostScripts is fast on an unterminated <script> flood", () => {
    expect(timed(() => detectGhostScripts(scriptBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("collectUnknownScripts is fast on an unterminated <script> flood", () => {
    expect(timed(() => collectUnknownScripts(scriptBomb))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("full scanThemeFiles is fast when every tag type is flooded at once", () => {
    const files: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: linkBomb.content },
      { filename: "sections/a.liquid", content: metaBomb.content },
      { filename: "snippets/b.liquid", content: scriptBomb.content },
    ];
    expect(timed(() => scanThemeFiles(files))).toBeLessThan(REDOS_BUDGET_MS * 3);
  });
});

describe("scan-engine ReDoS hardening — detection is unchanged", () => {
  // One well-formed instance of every hardened tag type, each attributable to a
  // known app so it must be flagged. Proves the isolate-then-match rewrite still
  // detects real ghost code (no regressions from the whole-file regex removal).
  const fixture: ThemeFile = {
    filename: "layout/theme.liquid",
    content: [
      '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=XXXX"></script>',
      '<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css" />',
      '<link rel="alternate" hreflang="fr" href="https://fr.example.com/" />',
      '<meta name="robots" content="noindex" />',
      '<link rel="canonical" href="" />',
      '<meta property="og:title" content="" />',
      '<link rel="preconnect" href="https://static.klaviyo.com" />',
    ].join("\n"),
  };

  it("flags one finding of each hardened tag category", () => {
    const { findings } = scanThemeFiles([fixture]);
    const types = new Set(findings.map((f) => f.findingType));

    expect(types).toContain(FindingType.GHOST_SCRIPT);
    expect(types).toContain(FindingType.GHOST_STYLE);
    expect(types).toContain(FindingType.GHOST_HREFLANG);
    expect(types).toContain(FindingType.GHOST_ROBOTS);
    expect(types).toContain(FindingType.GHOST_CANONICAL);
    expect(types).toContain(FindingType.GHOST_OG);
    expect(types).toContain(FindingType.GHOST_PRECONNECT);
  });

  it("reports each hardened finding at its correct 1-based line number", () => {
    const { findings } = scanThemeFiles([fixture]);
    const line = (type: FindingType) => findings.find((f) => f.findingType === type)?.lineNumber;

    expect(line(FindingType.GHOST_SCRIPT)).toBe(1);
    expect(line(FindingType.GHOST_STYLE)).toBe(2);
    expect(line(FindingType.GHOST_HREFLANG)).toBe(3);
    expect(line(FindingType.GHOST_ROBOTS)).toBe(4);
    expect(line(FindingType.GHOST_CANONICAL)).toBe(5);
    expect(line(FindingType.GHOST_OG)).toBe(6);
    expect(line(FindingType.GHOST_PRECONNECT)).toBe(7);
  });
});

describe("scan-engine file-size cap (gc-06e.2)", () => {
  const GHOST_SCRIPT_LINE =
    '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=XXXX"></script>';

  it("skips a scannable file over the cap and reports it in skippedFiles", () => {
    const oversized: ThemeFile = {
      filename: "layout/theme.liquid",
      content: GHOST_SCRIPT_LINE + "\n" + " ".repeat(MAX_SCANNABLE_FILE_BYTES + 1),
    };

    const result = scanThemeFiles([oversized]);

    expect(result.skippedFiles).toEqual([
      { filename: "layout/theme.liquid", size: oversized.content.length },
    ]);
    // The ghost script inside the oversized file must NOT be scanned.
    expect(result.findings).toHaveLength(0);
  });

  it("scans a file at/under the cap normally and leaves skippedFiles empty", () => {
    const normal: ThemeFile = {
      filename: "layout/theme.liquid",
      content: GHOST_SCRIPT_LINE,
    };

    const result = scanThemeFiles([normal]);

    expect(result.skippedFiles).toEqual([]);
    expect(result.findings.some((f) => f.findingType === FindingType.GHOST_SCRIPT)).toBe(true);
  });

  it("skips only the oversized file, leaving normal sibling files unaffected", () => {
    const files: ThemeFile[] = [
      {
        filename: "layout/theme.liquid",
        content: GHOST_SCRIPT_LINE + "\n" + " ".repeat(MAX_SCANNABLE_FILE_BYTES + 1),
      },
      { filename: "sections/header.liquid", content: GHOST_SCRIPT_LINE },
    ];

    const result = scanThemeFiles(files);

    expect(result.skippedFiles).toEqual([
      { filename: "layout/theme.liquid", size: files[0].content.length },
    ]);
    // The normal sibling is still scanned and its ghost script flagged.
    const scriptFindings = result.findings.filter(
      (f) => f.findingType === FindingType.GHOST_SCRIPT,
    );
    expect(scriptFindings).toHaveLength(1);
    expect(scriptFindings[0].filename).toBe("sections/header.liquid");
  });
});
