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

import { diffScans } from "../../app/services/scan-differ.server";
import {
  MAX_SCANNABLE_FILE_BYTES,
  collectThirdPartyDomains,
  collectUnknownScripts,
  collectUnknownStylesheets,
  detectDuplicateLibraries,
  detectDuplicateMetaTags,
  detectDuplicateTrackers,
  detectGhostCanonical,
  detectGhostFont,
  detectGhostHrefLang,
  detectGhostJsonLd,
  detectGhostOg,
  detectGhostPreconnect,
  detectGhostRobots,
  detectGhostScripts,
  detectGhostStyles,
  detectGhostTitle,
  detectInvalidJsonLd,
  detectJsonLdConflicts,
  detectOverlappingChatWidgets,
  extractStaticProductCandidates,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";
import { timedMinMs as timed } from "../test-utils/timing";

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

  // Tracker-ID matchers (GA4 / GTM / Meta / UA / TikTok). All are anchored and
  // bounded, so partial-match floods must not backtrack. This fragment carries a
  // dense run of unterminated tracker-shaped tokens for every platform regex.
  const trackerBomb: ThemeFile = {
    filename: "layout/theme.liquid",
    content: pathological("G-AAAA fbq('init','1234 ttq.load('AAAA UA-1234- GTM-AAAA "),
  };
  // Chat-widget signatures are plain host/substring checks plus one bounded
  // boundary-aware regex (zE(); a run of near-miss tokens must stay linear.
  const chatBomb: ThemeFile = {
    filename: "layout/theme.liquid",
    content: pathological("resize( size( zE zdassets intercom driftt "),
  };

  it("detectDuplicateTrackers is fast on an unterminated tracker-token flood", () => {
    expect(timed(() => detectDuplicateTrackers([trackerBomb]))).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("detectOverlappingChatWidgets is fast on a chat-signature near-miss flood", () => {
    expect(timed(() => detectOverlappingChatWidgets([chatBomb]))).toBeLessThan(REDOS_BUDGET_MS);
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

// ---------------------------------------------------------------------------
// gc-t7x: super-linear scans on adversarial input at the full 1 MB per-file cap
// ---------------------------------------------------------------------------

// Fill exactly MAX_SCANNABLE_FILE_BYTES chars (the largest file the per-file
// detectors still run on) by repeating `fragment`, optionally wrapped. At this
// size a quadratic scan takes tens of seconds to minutes (past the scan worker
// timeout), while the linear rewrites finish in well under a second.
function atCap(fragment: string, prefix = "", suffix = ""): string {
  const body = MAX_SCANNABLE_FILE_BYTES - prefix.length - suffix.length;
  return prefix + fragment.repeat(Math.ceil(body / fragment.length)).slice(0, body) + suffix;
}

// Generous per-detector ceiling for a 1 MB adversarial file: the quadratic
// versions blew past it by 10x-1000x, the linear ones run in tens of ms.
const CAP_BUDGET_MS = 1500;

// For inputs that legitimately produce tens of thousands of findings, whose
// per-finding work is linear but not free.
const DENSE_FINDINGS_BUDGET_MS = 6000;

function layout(content: string): ThemeFile {
  return { filename: "layout/theme.liquid", content };
}

describe("gc-t7x — detectGhostTitle is linear on unterminated / flooded titles", () => {
  it.each([
    ["<title> openers with no closer", atCap("<title>")],
    ["<title openers with no >", atCap("<title")],
    ["alternating <title><title>", atCap("<title><title>")],
    ["one <title> + 1 MB of text", atCap("a", "<title>")],
    ["one closed title whose content is a {{ flood", atCap("{{", "<title>", "</title>")],
    ["one closed title whose content is a {{a flood", atCap("{{a", "<title>", "</title>")],
    // Many findings on a line between two long lines: the snippet builder used
    // to join all three full lines per finding.
    [
      "duplicate titles on a line between two ~333 KB lines",
      "x".repeat(333_000) +
        "\n" +
        "<title>a</title>".concat("y".repeat(84)).repeat(3330) +
        "\n" +
        "z".repeat(333_000),
    ],
  ])("%s", (_label, content) => {
    expect(timed(() => detectGhostTitle(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
  });

  it("still reports a duplicate title after an earlier unclosed-looking opener", () => {
    const findings = detectGhostTitle(
      layout("<title>{{ page_title }}</title>\n<title>Shop</title>\n<title"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(2);
    expect(findings[0].description).toContain("Duplicate title tag");
  });
});

describe("gc-t7x — JSON-LD block extraction is linear on unterminated blocks", () => {
  const detectors: Array<[string, (file: ThemeFile) => unknown]> = [
    ["detectGhostJsonLd", detectGhostJsonLd],
    ["detectInvalidJsonLd", detectInvalidJsonLd],
    ["detectJsonLdConflicts", detectJsonLdConflicts],
    ["extractStaticProductCandidates", extractStaticProductCandidates],
  ];
  const floods: Array<[string, string]> = [
    ["ld+json openers with no </script>", atCap('<script type="application/ld+json">{')],
    ["ld+json openers with no >", atCap('<script type="application/ld+json"')],
  ];

  for (const [name, detect] of detectors) {
    it.each(floods)(`${name}: %s`, (_label, content) => {
      expect(timed(() => detect(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
    });
  }

  it("detectJsonLdConflicts is linear in the number of identical blocks", () => {
    // ~16K identical blocks of one @type: each used to be compared against
    // every earlier block while searching for one that differs (~1.8s; now
    // ~20ms, so the tighter budget still leaves wide headroom).
    const content = atCap('<script type="application/ld+json">{"@type":"FAQPage"}</script>');
    expect(timed(() => detectJsonLdConflicts(layout(content)))).toBeLessThan(REDOS_BUDGET_MS);
  });
});

describe("gc-t7x — @font-face scanning is linear on unterminated / flooded blocks", () => {
  it.each([
    ["@font-face { openers with no }", atCap("@font-face {")],
    ["@font-face{font-family: openers with no }", atCap("@font-face{font-family:")],
    ["one block holding a url(// flood", atCap("url(//a", "@font-face{src:", "}")],
    ["one block holding a url(' flood", atCap("url('//a ", "@font-face{src:", "}")],
  ])("collectThirdPartyDomains: %s", (_label, content) => {
    expect(timed(() => collectThirdPartyDomains(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
  });

  it.each([
    ["@font-face { openers with no }", atCap("@font-face {")],
    ["openers sharing one block with matching font-family", atCap("@font-face{font-family:x ")],
    ["openers sharing one block with no font-family match", atCap("@font-face{font-family ")],
    ["one opener then a font-family: flood", atCap("font-family:x ", "@font-face{")],
  ])("detectGhostFont: %s", (_label, content) => {
    expect(timed(() => detectGhostFont(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
  });
});

describe("gc-t7x — meta/canonical value checks are linear on adversarial input", () => {
  it("detectGhostOg: OG tags packed on one 1 MB line", () => {
    // ~27K findings on one line. Each still costs a linear amount (app
    // attribution of its snippet, ~1.2s in total), but the per-tag re-test of
    // the whole 1 MB line for a Liquid conditional made it ~12s. The looser
    // budget keeps that separation without flaking under parallel test load.
    const content = atCap('<meta property="og:title" content="">');
    expect(timed(() => detectGhostOg(layout(content)))).toBeLessThan(DENSE_FINDINGS_BUDGET_MS);
  });

  it.each([
    [
      "OG tags spread along one 1 MB line",
      atCap('<meta property="og:title" content="">' + "x".repeat(460)),
    ],
    [
      "an OG content value holding a { flood",
      atCap("{", '<meta property="og:title" content="', '">'),
    ],
    [
      "an OG content value holding a {{a flood",
      atCap("{{a", '<meta property="og:title" content="', '">'),
    ],
  ])("detectGhostOg: %s", (_label, content) => {
    expect(timed(() => detectGhostOg(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
  });

  it.each([
    ["a canonical href holding a { flood", atCap("{", '<link rel="canonical" href="', '">')],
    [
      "a canonical href holding unclosed safe-variable heads",
      atCap("{{ url |", '<link rel="canonical" href="', 'a}b{{x}}">'),
    ],
  ])("detectGhostCanonical: %s", (_label, content) => {
    expect(timed(() => detectGhostCanonical(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
  });

  it("detectDuplicateMetaTags: duplicate meta tags spread along one 1 MB line", () => {
    // App attribution used to run against the whole 1 MB line once per duplicate.
    const content = atCap('<meta name="description" content="a">' + "x".repeat(460));
    expect(timed(() => detectDuplicateMetaTags(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
  });
});

describe("gc-t7x — tag attribute matching is linear on one huge tag", () => {
  // extractTags cuts a tag at its first `>`, so each of these is ONE 1 MB tag.
  // The per-tag regexes backtracked quadratically on it: from every inner
  // `<link` start, and over every candidate position of an early attribute.
  const linkTags: Array<[string, string]> = [
    ["a <link flood", atCap("<link ", "", ">")],
    ["rel=stylesheet candidates", atCap(' rel="stylesheet"', "<link", ">")],
    ["href candidates", atCap(' href="//a"', "<link", ">")],
    ["rel=alternate candidates", atCap(' rel="alternate"', "<link", ">")],
    ["rel=preconnect candidates", atCap(' rel="preconnect"', "<link", ">")],
    ["rel=canonical candidates", atCap(' rel="canonical"', "<link", ">")],
  ];
  const linkDetectors: Array<[string, (file: ThemeFile) => unknown]> = [
    ["detectGhostStyles", detectGhostStyles],
    ["detectGhostHrefLang", detectGhostHrefLang],
    ["detectGhostCanonical", detectGhostCanonical],
    ["detectGhostPreconnect", detectGhostPreconnect],
    ["detectGhostFont", detectGhostFont],
    ["collectUnknownStylesheets", collectUnknownStylesheets],
    ["collectThirdPartyDomains", collectThirdPartyDomains],
  ];
  for (const [name, detect] of linkDetectors) {
    it.each(linkTags)(`${name}: %s`, (_label, content) => {
      expect(timed(() => detect(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
    });
  }

  const metaTags: Array<[string, string]> = [
    ["a <meta flood", atCap("<meta ", "", ">")],
    ["name=robots candidates", atCap(' name="robots"', "<meta", ">")],
    ["content candidates", atCap(' content="noindex"', "<meta", ">")],
    ["property=og candidates", atCap(' property="og:x"', "<meta", ">")],
  ];
  const metaDetectors: Array<[string, (file: ThemeFile) => unknown]> = [
    ["detectDuplicateMetaTags", detectDuplicateMetaTags],
    ["detectGhostRobots", detectGhostRobots],
    ["detectGhostOg", detectGhostOg],
  ];
  for (const [name, detect] of metaDetectors) {
    it.each(metaTags)(`${name}: %s`, (_label, content) => {
      expect(timed(() => detect(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
    });
  }

  const scriptTags: Array<[string, string]> = [
    ["a <script flood", atCap("<script ", "", ">")],
    ["src candidates", atCap(' src="//a"', "<script", ">")],
  ];
  const scriptDetectors: Array<[string, (file: ThemeFile) => unknown]> = [
    ["detectGhostScripts", detectGhostScripts],
    ["collectUnknownScripts", collectUnknownScripts],
    ["collectThirdPartyDomains", collectThirdPartyDomains],
    ["detectDuplicateLibraries", (file) => detectDuplicateLibraries([file])],
  ];
  for (const [name, detect] of scriptDetectors) {
    it.each(scriptTags)(`${name}: %s`, (_label, content) => {
      expect(timed(() => detect(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
    });
  }
});

describe("font <link> href matching is linear on one huge unterminated href", () => {
  // FONT_LINK_TAG's catch-all alternative was `href="(https?://[^"']*font[^"']*)"`:
  // with no closing quote, every `font` made the regex rescan to the end of the
  // tag (100 KB ~1.5s, 1 MB > 25s). Both detectors that apply it are covered.
  const content = atCap("font", '<link href="https://', ">");
  const detectors: Array<[string, (file: ThemeFile) => unknown]> = [
    ["detectGhostFont", detectGhostFont],
    ["collectThirdPartyDomains", collectThirdPartyDomains],
  ];
  it.each(detectors)("%s: a font flood with no closing quote", (_name, detect) => {
    expect(timed(() => detect(layout(content)))).toBeLessThan(CAP_BUDGET_MS);
  });
});

describe("gc-t7x — end-to-end: one 1 MB file mixing the worst patterns", () => {
  // Equal slices of every super-linear pattern the gc-t7x sweep found. The
  // self-contained slices come first; the unterminated floods come last,
  // ordered so that nothing after a flood closes it (a later `>`, `}`,
  // `</title>` or `</script>` would let the old regexes match instead of
  // rescanning to EOF).
  const slices: Array<[string, string, string]> = [
    ["<title>", "{{a", "</title>\n"],
    ["<style>@font-face{src:", "url(//a", "}</style>\n"],
    ["", "@font-face{font-family ", "\n"],
    ['<meta property="og:title" content="', "{{a", '">\n'],
    ['<link rel="canonical" href="', "{{ url |", 'a}b{{x}}">\n'],
    ["<link", ' rel="alternate"', ">\n"],
    ["<link", ' rel="stylesheet"', ">\n"],
    ['<link href="https://', "font", ">\n"],
    ["<meta", ' name="robots"', ">\n"],
    ["", "jsonld", "\n"],
    ["", "data-ref ", "\n"],
    ["", '<meta name="description" content="a">' + "x".repeat(460), "\n"],
    ["", "<title>a</title>" + "y".repeat(84), "\n"],
    ["", "<title>", ""],
    ["", '<script type="application/ld+json">{', ""],
    ["", "<script ", ">"],
    ["", "<link ", ">"],
    ["", "<title", ""],
    ["", "@font-face {", ""],
  ];
  const perSlice = Math.floor(MAX_SCANNABLE_FILE_BYTES / slices.length);
  const content = slices
    .map(([prefix, fragment, suffix]) => {
      const body = perSlice - prefix.length - suffix.length;
      return prefix + fragment.repeat(Math.ceil(body / fragment.length)).slice(0, body) + suffix;
    })
    .join("");

  it("scanThemeFiles finishes far inside the 30s scan worker timeout", () => {
    // WORKER_TIMEOUT_MS in scan-pool.server.ts is 30s; the scan now takes
    // ~200ms, so a sixth of the timeout still leaves wide headroom.
    expect(content.length).toBeLessThanOrEqual(MAX_SCANNABLE_FILE_BYTES);
    let result: ReturnType<typeof scanThemeFiles> | undefined;
    const elapsed = timed(() => {
      result = scanThemeFiles([layout(content)]);
    });
    expect(elapsed).toBeLessThan(5000);
    expect(result?.skippedFiles).toEqual([]);
    expect(result?.findings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// gc-tus.11: Pass 5 (duplicate libraries) and size-guard-skipped files
// ---------------------------------------------------------------------------

describe("gc-tus.11 — duplicate-library pass over size-guard-skipped files", () => {
  // Decision: Pass 5 KEEPS scanning files the per-file size guard skipped, like
  // the other cross-file passes. DUPLICATE_LIBRARY is in CROSS_FILE_FINDING_TYPES,
  // so the differ diffs it normally even when its anchor file is size-skipped.
  // Dropping skipped files from this pass would make a still-present conflict
  // anchored in (or depending on) the oversized file vanish from the current
  // scan and read as a false "resolved" (and re-anchor elsewhere as "new").
  // Keeping them is safe because the pass is linear (pinned below).
  const scriptTag = (url: string) => `<script src="${url}"></script>`;
  const SWIPER_8 = scriptTag("https://cdn.jsdelivr.net/npm/swiper@8.4.5/swiper-bundle.min.js");
  const SWIPER_11 = scriptTag("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js");
  type Scan = ReturnType<typeof scanThemeFiles>;
  const skippedNames = (r: Scan | undefined) => (r?.skippedFiles ?? []).map((f) => f.filename);
  const dupsOnly = (r: Scan) =>
    r.findings
      .filter((f) => f.findingType === FindingType.DUPLICATE_LIBRARY)
      .map((f) => ({ ...f, appName: f.appName ?? null }));
  const oversized = (head: string): ThemeFile => ({
    filename: "layout/theme.liquid",
    content: head + "\n" + " ".repeat(MAX_SCANNABLE_FILE_BYTES + 1),
  });

  it("still reports a conflict whose copies include an oversized file", () => {
    const files = [oversized(SWIPER_8), { filename: "sections/hero.liquid", content: SWIPER_11 }];
    const result = scanThemeFiles(files);

    expect(skippedNames(result)).toEqual(["layout/theme.liquid"]);
    const dups = result.findings.filter((f) => f.findingType === FindingType.DUPLICATE_LIBRARY);
    expect(dups).toHaveLength(1);
    // Anchored at the lowest major, which lives in the oversized file.
    expect(dups[0].filename).toBe("layout/theme.liquid");
    expect(dups[0].lineNumber).toBe(1);
  });

  it("does not churn: a rescan with the file still oversized diffs as unchanged", () => {
    const files = [oversized(SWIPER_8), { filename: "sections/hero.liquid", content: SWIPER_11 }];
    const previous = scanThemeFiles(files);
    const current = scanThemeFiles(files);

    const diff = diffScans(dupsOnly(current), dupsOnly(previous), {
      skippedFiles: skippedNames(current),
    });
    expect(diff.resolvedFindings).toEqual([]);
    expect(diff.newFindings).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("does not report a false resolution when the anchor file grows past the cap", () => {
    const hero = { filename: "sections/hero.liquid", content: SWIPER_11 };
    const before = scanThemeFiles([{ filename: "layout/theme.liquid", content: SWIPER_8 }, hero]);
    const after = scanThemeFiles([oversized(SWIPER_8), hero]);

    expect(skippedNames(before)).toEqual([]);
    expect(skippedNames(after)).toEqual(["layout/theme.liquid"]);
    const diff = diffScans(dupsOnly(after), dupsOnly(before), {
      skippedFiles: skippedNames(after),
    });
    expect(diff.resolvedFindings).toEqual([]);
    expect(diff.newFindings).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("reports the genuine resolution when the oversized file's copy is removed", () => {
    const before = scanThemeFiles([
      oversized(SWIPER_8),
      { filename: "sections/hero.liquid", content: SWIPER_11 },
    ]);
    const after = scanThemeFiles([
      oversized("<p>no swiper here</p>"),
      { filename: "sections/hero.liquid", content: SWIPER_11 },
    ]);

    const diff = diffScans(dupsOnly(after), dupsOnly(before), {
      skippedFiles: skippedNames(after),
    });
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.newFindings).toEqual([]);
  });

  // Just over the cap, so these files are size-skipped for the per-file
  // detectors but still flow through Pass 5.
  const OVER_CAP = MAX_SCANNABLE_FILE_BYTES + 200_000;
  const fill = (fragment: string, prefix = "", suffix = "") => {
    const body = OVER_CAP - prefix.length - suffix.length;
    return prefix + fragment.repeat(Math.ceil(body / fragment.length)).slice(0, body) + suffix;
  };
  const adversarial: Array<[string, string, number]> = [
    ["an unterminated <script flood", fill("<script "), CAP_BUDGET_MS],
    [
      "one tag with a src flood",
      fill(' src="//cdn.jsdelivr.net/npm/a@1/x.js"', "<script", ">"),
      CAP_BUDGET_MS,
    ],
    [
      "one 1 MB package name",
      fill("a", '<script src="https://cdn.jsdelivr.net/npm/', '@1/x.js">'),
      CAP_BUDGET_MS,
    ],
    [
      "an @ flood in an unpkg path",
      fill("@", '<script src="https://unpkg.com/', '">'),
      CAP_BUDGET_MS,
    ],
    [
      "a 1 MB version segment",
      fill("1.", '<script src="https://unpkg.com/a@', '/x.js">'),
      CAP_BUDGET_MS,
    ],
    [
      "a cdnjs segment flood",
      fill("a/", '<script src="https://cdnjs.cloudflare.com/ajax/libs/', '">'),
      CAP_BUDGET_MS,
    ],
    ["dense CDN library tags on one line", fill(SWIPER_8 + SWIPER_11), DENSE_FINDINGS_BUDGET_MS],
    ["dense CDN library tags, one per line", fill(SWIPER_8 + "\n"), DENSE_FINDINGS_BUDGET_MS],
  ];

  it.each(adversarial)("Pass 5 is linear on an oversized file: %s", (_label, content, budget) => {
    expect(content.length).toBeGreaterThan(MAX_SCANNABLE_FILE_BYTES);
    const files = [layout(content), { filename: "sections/hero.liquid", content: SWIPER_11 }];
    expect(timed(() => detectDuplicateLibraries(files))).toBeLessThan(budget);
    let result: Scan | undefined;
    expect(timed(() => (result = scanThemeFiles(files)))).toBeLessThan(budget);
    expect(skippedNames(result)).toEqual(["layout/theme.liquid"]);
  });
});
