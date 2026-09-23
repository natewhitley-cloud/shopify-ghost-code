/**
 * Per-file, per-finding-type cap regression tests (gc-ypk).
 *
 * Background: the per-file detectors in scanThemeFiles cost tens of µs per
 * emitted finding (mostly identifyAppFromCode on the snippet). A tag-dense 1 MB
 * file can emit tens of thousands of findings of one type (~3 s for one
 * <title> flood), so a theme with 10+ such files could approach the 30 s scan
 * worker timeout and FAIL the scan. Real themes emit a handful of findings per
 * file (prod max per SCAN ~26).
 *
 * The cap keeps the FIRST MAX_FINDINGS_PER_FILE_PER_TYPE findings by line for
 * each (file, type), deterministically, records every cap hit in
 * ScanResult.findingCapHits, and bounds the WORK (the expensive detectors stop
 * early) rather than only the output. MALICIOUS_SCRIPT is exempt.
 */

import { FindingType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MAX_FINDINGS_PER_FILE_PER_TYPE } from "../../app/lib/scan-limits";
import type { CreateFindingInput } from "../../app/models/finding.server";
import { identifyAppFromCode } from "../../app/services/app-lookup.server";
import { diffScans } from "../../app/services/scan-differ.server";
import {
  detectDuplicateMetaTags,
  detectGhostAjax,
  detectGhostCanonical,
  detectGhostFont,
  detectGhostHrefLang,
  detectGhostJsonLd,
  detectGhostOg,
  detectGhostPreconnect,
  detectGhostRobots,
  detectGhostScripts,
  detectGhostSections,
  detectGhostSnippets,
  detectGhostStyles,
  detectGhostTextFragments,
  detectGhostTitle,
  detectInvalidJsonLd,
  detectJsonLdConflicts,
  detectSettingsDrift,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";

// Count identifyAppFromCode calls (the dominant per-finding cost) while keeping
// its real behavior, to assert that capped detectors stop doing the work.
vi.mock("../../app/services/app-lookup.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/app-lookup.server")>();
  return { ...actual, identifyAppFromCode: vi.fn(actual.identifyAppFromCode) };
});
const identifySpy = identifyAppFromCode as unknown as ReturnType<typeof vi.fn>;

const CAP = MAX_FINDINGS_PER_FILE_PER_TYPE;

/** Fill ~1 MB (under MAX_SCANNABLE_FILE_BYTES) with one line fragment. */
function dense(fragment: string, bytes = 990_000): string {
  return fragment.repeat(Math.floor(bytes / fragment.length));
}

/** The reference definition of the cap: stable sort by line, keep the first N. */
function firstNByLine(findings: CreateFindingInput[], n: number): CreateFindingInput[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.lineNumber - b.f.lineNumber || a.i - b.i)
    .slice(0, n)
    .map(({ f }) => f);
}

const diffable = (findings: CreateFindingInput[]) =>
  findings.map((f) => ({ ...f, appName: f.appName ?? null }));

const byType = (findings: CreateFindingInput[], type: FindingType) =>
  findings.filter((f) => f.findingType === type);

// One tag-dense line per capped per-file detector. Every line emits exactly one
// or more findings of the named type (the suite asserts uncapped > CAP).
type Detector = (file: ThemeFile, limit?: number) => CreateFindingInput[];
const DENSE_CASES: Array<[FindingType, string, Detector]> = [
  [
    FindingType.GHOST_SCRIPT,
    '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>\n',
    detectGhostScripts,
  ],
  [
    FindingType.GHOST_STYLE,
    '<link rel="stylesheet" href="https://static.klaviyo.com/x.css">\n',
    detectGhostStyles,
  ],
  [FindingType.GHOST_SNIPPET, "{% render 'klaviyo-form' %}\n", detectGhostSnippets],
  [FindingType.GHOST_SECTION, "{% section 'shogun-head' %}\n", detectGhostSections],
  [
    FindingType.GHOST_HREFLANG,
    '<link rel="alternate" hreflang="fr" href="https://fr.example.com/products" />\n',
    detectGhostHrefLang,
  ],
  [FindingType.DUPLICATE_META, '<meta name="description" content="a">\n', detectDuplicateMetaTags],
  [
    FindingType.GHOST_JSON_LD,
    '<script type="application/ld+json">{"@type":"Product","url":"https://judge.me/reviews/p"}</script>\n',
    detectGhostJsonLd,
  ],
  [
    FindingType.JSON_LD_INVALID,
    '<script type="application/ld+json">{bad</script>\n',
    detectInvalidJsonLd,
  ],
  [
    FindingType.GHOST_TEXT,
    '<div id="jdgm-widget" class="review-widget"></div>\n',
    detectGhostTextFragments,
  ],
  [FindingType.GHOST_ROBOTS, '<meta name="robots" content="noindex">\n', detectGhostRobots],
  [FindingType.GHOST_CANONICAL, '<link rel="canonical" href="">\n', detectGhostCanonical],
  [FindingType.GHOST_TITLE, "<title>a</title>\n", detectGhostTitle],
  [FindingType.GHOST_OG, '<meta property="og:title" content="">\n', detectGhostOg],
  [
    FindingType.GHOST_PRECONNECT,
    '<link rel="preconnect" href="https://static.klaviyo.com">\n',
    detectGhostPreconnect,
  ],
  [
    FindingType.GHOST_FONT,
    '<style>@font-face { font-family: "J"; src: url("https://cdn.judge.me/fonts/review.woff2"); }</style>\n',
    detectGhostFont,
  ],
  [
    FindingType.GHOST_AJAX,
    '<script>fetch("https://cdn.judge.me/api/reviews");</script>\n',
    detectGhostAjax,
  ],
  [
    FindingType.JSON_LD_CONFLICT,
    '<script type="application/ld+json">{"@type":"Product","name":"W","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.5"}}</script>\n' +
      '<script type="application/ld+json">{"@type":"Product","name":"W","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.2"}}</script>\n',
    detectJsonLdConflicts,
  ],
];

describe("gc-ypk — per-file, per-type finding cap", () => {
  it("is a sane named limit, far above real-theme per-file counts", () => {
    expect(CAP).toBe(200);
  });

  describe.each(DENSE_CASES)("%s flood", (type, fragment, detect) => {
    // Small (2x CAP repeats) so the uncapped reference stays cheap to compute.
    const small: ThemeFile = { filename: "layout/theme.liquid", content: fragment.repeat(CAP * 2) };

    it("keeps exactly the first CAP findings by line and records the cap hit", () => {
      const result = scanThemeFiles([small]);
      const kept = byType(result.findings, type);

      expect(kept).toHaveLength(CAP);
      // Line order is non-decreasing (first N by line)...
      for (let i = 1; i < kept.length; i++) {
        expect(kept[i].lineNumber).toBeGreaterThanOrEqual(kept[i - 1].lineNumber);
      }
      // ...and it is exactly the uncapped detector's first CAP by line.
      expect(detect(small).length).toBeGreaterThan(CAP);
      expect(kept).toEqual(firstNByLine(detect(small), CAP));
      // Some floods also trip a sibling type (e.g. og:title also duplicates a
      // meta tag); each capped type is counted on its own.
      expect(result.findingCapHits?.[type]).toBe(1);
    });

    it("is deterministic across rescans (fingerprint stability)", () => {
      const a = scanThemeFiles([small]);
      const b = scanThemeFiles([small]);
      expect(b.findings).toEqual(a.findings);
      const diff = diffScans(diffable(b.findings), diffable(a.findings));
      expect(diff.resolvedFindings).toEqual([]);
      expect(diff.newFindings).toEqual([]);
    });
  });

  it("a 1 MB tag-dense <title> file emits exactly CAP findings, bounded work, fast", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: dense("<title>a</title>\n"),
    };
    // Uncapped this file emitted ~58k GHOST_TITLE findings (~3 s).
    identifySpy.mockClear();
    const start = performance.now();
    const result = scanThemeFiles([file]);
    const elapsed = performance.now() - start;

    expect(byType(result.findings, FindingType.GHOST_TITLE)).toHaveLength(CAP);
    expect(result.findingCapHits).toEqual({ [FindingType.GHOST_TITLE]: 1 });
    // Work is bounded, not just output: identifyAppFromCode ran O(CAP) times,
    // not once or twice per <title> (~58k lines).
    expect(identifySpy.mock.calls.length).toBeLessThan(CAP * 10);
    // Generous CI bound (was ~3 s before the cap; ~0.3 s after).
    expect(elapsed).toBeLessThan(2000);
    // Same output on a repeat run.
    expect(scanThemeFiles([file]).findings).toEqual(result.findings);
  });

  it.each([
    ["canonical", '<link rel="canonical" href="">\n'],
    // Valid, unattributed hrefs: checks 1-3 emit nothing, every one is a duplicate.
    ["duplicate-only canonical", '<link rel="canonical" href="https://a.com/">\n'],
    ["robots", '<meta name="robots" content="noindex">\n'],
    ["og", '<meta property="og:title" content="">\n'],
    ["meta", '<meta name="description" content="a">\n'],
    // One 1 MB line: no line boundary to stop at, so the per-line memo bounds it.
    ["single-line title", "<title>a</title>"],
    ["single-line canonical", '<link rel="canonical" href="https://a.com/">'],
  ])("bounds identifyAppFromCode work on a 1 MB %s flood", (_name, fragment) => {
    const file: ThemeFile = { filename: "layout/theme.liquid", content: dense(fragment) };
    identifySpy.mockClear();
    scanThemeFiles([file]);
    expect(identifySpy.mock.calls.length).toBeLessThan(CAP * 10);
  });

  it("never caps MALICIOUS_SCRIPT (security alert is shown in full)", () => {
    const line = '<script src="https://jsdeliver.cloud/x.js"></script>\n';
    const file: ThemeFile = { filename: "layout/theme.liquid", content: line.repeat(CAP * 3) };
    const result = scanThemeFiles([file]);
    expect(byType(result.findings, FindingType.MALICIOUS_SCRIPT)).toHaveLength(CAP * 3);
    expect(result.findingCapHits?.[FindingType.MALICIOUS_SCRIPT]).toBeUndefined();
  });

  it("caps each file independently and counts every capped file", () => {
    const content = "<title>a</title>\n".repeat(CAP + 5);
    const result = scanThemeFiles([
      { filename: "layout/theme.liquid", content },
      { filename: "layout/alt.liquid", content },
    ]);
    const titles = byType(result.findings, FindingType.GHOST_TITLE);
    expect(titles.filter((f) => f.filename === "layout/theme.liquid")).toHaveLength(CAP);
    expect(titles.filter((f) => f.filename === "layout/alt.liquid")).toHaveLength(CAP);
    expect(result.findingCapHits).toEqual({ [FindingType.GHOST_TITLE]: 2 });
  });

  it("does not cap (or report) a file at exactly the cap", () => {
    // Title #1 is valid; titles #2..#CAP+1 are duplicates: exactly CAP findings.
    const content = "<title>a</title>\n".repeat(CAP + 1);
    const result = scanThemeFiles([{ filename: "layout/theme.liquid", content }]);
    expect(byType(result.findings, FindingType.GHOST_TITLE)).toHaveLength(CAP);
    expect(result.findingCapHits).toEqual({});
  });

  it("leaves a normal file untouched and reports no cap hits", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      // Blank lines keep the script out of the titles' 3-line snippets.
      content: [
        "<title>a</title>",
        "",
        "",
        '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>',
        "",
        "",
        "<title>b</title>",
      ].join("\n"),
    };
    const result = scanThemeFiles([file]);
    expect(result.findingCapHits).toEqual({});
    expect(byType(result.findings, FindingType.GHOST_TITLE)).toHaveLength(1);
    expect(byType(result.findings, FindingType.GHOST_SCRIPT)).toHaveLength(1);
  });

  it("reports an empty cap map for an empty theme", () => {
    expect(scanThemeFiles([]).findingCapHits).toEqual({});
  });

  it("caps the cross-file settings-drift pass (unbounded in settings_data.json)", () => {
    const sections: Record<string, { type: string }> = {};
    for (let i = 0; i < CAP * 3; i++) sections[`s${i}`] = { type: `gone-${i}` };
    const files: ThemeFile[] = [
      {
        filename: "config/settings_data.json",
        content: JSON.stringify({ current: { sections } }),
      },
    ];
    const uncapped = detectSettingsDrift(files);
    expect(uncapped).toHaveLength(CAP * 3);

    const result = scanThemeFiles(files);
    const drift = byType(result.findings, FindingType.SETTINGS_DRIFT);
    // All drift findings sit on line 1, so first-N-by-line = first N in the
    // (deterministic) settings key order.
    expect(drift).toEqual(uncapped.slice(0, CAP));
    expect(result.findingCapHits).toEqual({ [FindingType.SETTINGS_DRIFT]: 1 });
  });
});

// ---------------------------------------------------------------------------
// Early-exit correctness: a detector given `limit` must return a superset of
// the uncapped first-`limit`-by-line findings (and nothing that the uncapped
// run would not emit), so scanThemeFiles' sort+truncate yields exactly the
// uncapped first N by line. Mixed inputs exercise every emission path,
// including several tags per line and multi-pass (duplicate) emission.
// ---------------------------------------------------------------------------

describe("gc-ypk — early exit is equivalent to truncating the full output", () => {
  const titleMix = [
    "<title>{{ shop.name }}</title>",
    "<title></title><title>ok</title>",
    "<title>{{ app.x }}</title>",
    "{% if a %}<title>c</title>{% endif %}",
    "<title>klaviyo</title><title></title>",
    "<svg><title>icon</title></svg>",
    "<title>plain</title>",
    // A duplicate (check 4) BEFORE a check 1-3 hit on the same line: a stop
    // between them would reorder the tie on that line.
    "<title>ok</title><title>{{ app.y }}</title>",
  ];
  const canonicalMix = [
    '<link rel="canonical" href="https://a.com/">',
    '<link rel="canonical" href=""><link rel="canonical" href="https://b.com/">',
    '<link rel="canonical" href="{{ app.url }}">',
    '<link rel="canonical" href="https://c.com/"><link rel="canonical" href="{{ x.y }}">',
    '<link rel="canonical" href="{{ canonical_url }}">',
    '{% if a %}<link rel="canonical" href="">{% endif %}',
    '<link rel="canonical" href="relative/path">',
  ];
  const metaMix = [
    '<meta name="description" content="a"><meta property="og:title" content="x">',
    '<meta property="og:title" content="y">',
    '<meta name="description" content="b"><meta name="description" content="c">',
    '<meta name="keywords" content="k">',
    '<meta name="keywords" content="k2"><meta property="og:image" content="i">',
  ];
  const robotsMix = [
    '<meta name="robots" content="noindex"><meta name="robots" content="index">',
    '<meta name="robots" content="nofollow">',
    '{% if a %}<meta name="robots" content="noindex">{% endif %}',
  ];
  const ogMix = [
    '<meta property="og:title" content="">',
    '<meta property="og:title" content="ok"><meta property="og:image" content="{{ app.img }}">',
    '<meta property="og:description" content="klaviyo">',
    '<meta name="twitter:title" content="">',
  ];

  const build = (mix: string[], lines: number) =>
    Array.from({ length: lines }, (_, i) => mix[(i * 7 + (i >> 2)) % mix.length]).join("\n");

  const cases: Array<[string, (f: ThemeFile, limit?: number) => CreateFindingInput[], string[]]> = [
    ["detectGhostTitle", detectGhostTitle, titleMix],
    ["detectGhostCanonical", detectGhostCanonical, canonicalMix],
    ["detectDuplicateMetaTags", detectDuplicateMetaTags, metaMix],
    ["detectGhostRobots", detectGhostRobots, robotsMix],
    ["detectGhostOg", detectGhostOg, ogMix],
  ];

  describe.each(cases)("%s", (_name, detect, mix) => {
    const variants: Array<[string, string, string]> = [
      ["layout, multi-line", "layout/theme.liquid", build(mix, 120)],
      ["section, multi-line", "sections/main.liquid", build(mix, 120)],
      // A Liquid conditional anywhere on the line would skip it wholesale.
      [
        "layout, one line",
        "layout/theme.liquid",
        build(
          mix.filter((l) => !l.includes("{%")),
          120,
        ).replaceAll("\n", ""),
      ],
    ];
    for (const [label, filename, content] of variants) {
      const file: ThemeFile = { filename, content };

      it(`matches the uncapped first-N-by-line for every limit (${label})`, () => {
        const full = detect(file);
        expect(full.length).toBeGreaterThan(5);
        for (const limit of [1, 2, 3, 5, 8, 13, 21, full.length - 1, full.length]) {
          const early = detect(file, limit);
          // Everything the early exit emits, the full run emits too.
          for (const f of early) expect(full).toContainEqual(f);
          expect(firstNByLine(early, limit)).toEqual(firstNByLine(full, limit));
        }
      });
    }
  });

  it("an unlimited call returns the same output as before (no limit passed)", () => {
    const file: ThemeFile = { filename: "layout/theme.liquid", content: build(titleMix, 50) };
    expect(detectGhostTitle(file, Number.POSITIVE_INFINITY)).toEqual(detectGhostTitle(file));
  });
});
