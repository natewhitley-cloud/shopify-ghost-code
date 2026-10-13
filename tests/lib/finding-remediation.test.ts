/**
 * Tests for app/lib/finding-remediation.ts
 *
 * Strategy:
 *   - Pure function with no dependencies — test directly.
 *   - Every FindingType enum value must return a non-empty, accurate blurb.
 *   - Spot-check a few blurbs for accuracy (theme-file edits vs. Admin
 *     resources) so a mis-grouped type is caught.
 *   - Unmapped/unknown/empty input must fall back to generic guidance.
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { THEME_FILE_TYPE_SETS } from "../../app/lib/finding-classification";
import {
  buildRemovalInstructions,
  findingMatchedLine,
  getFindingImpact,
  getFindingRemediation,
  LINE_CONTEXT_SNIPPET_TYPES,
  matchedLineFromContextSnippet,
} from "../../app/lib/finding-remediation";
import { buildSnippet } from "../../app/services/scan-engine.server";

// The finding types that carry an agentic "why it matters" impact line — the
// signals AI shopping agents and answer engines read (canonical/hreflang/meta
// robots/JSON-LD/duplicate meta). Kept in sync with REMEDIATION in the module.
const AGENTIC_IMPACT_TYPES = [
  "GHOST_CANONICAL",
  "GHOST_HREFLANG",
  "GHOST_ROBOTS",
  "GHOST_JSON_LD",
  "GHOST_OG",
  "JSON_LD_CONFLICT",
  "JSON_LD_PRICE_CONFLICT",
  "JSON_LD_INVALID",
  "DUPLICATE_META",
  "DANGLING_REFERENCE",
] as const;

// ---------------------------------------------------------------------------
// Coverage: every enum type has a non-empty, em-dash-free blurb
// ---------------------------------------------------------------------------

describe("getFindingRemediation — coverage", () => {
  const ALL_TYPES = Object.values(FindingType);

  it("has 39 finding types (guards against silent enum drift)", () => {
    expect(ALL_TYPES).toHaveLength(39);
  });

  it.each(ALL_TYPES)("returns a non-empty blurb for %s", (type) => {
    const blurb = getFindingRemediation(type);
    expect(typeof blurb).toBe("string");
    expect(blurb.trim().length).toBeGreaterThan(0);
  });

  it.each(ALL_TYPES)("blurb for %s contains no em-dash or en-dash", (type) => {
    const blurb = getFindingRemediation(type);
    expect(blurb).not.toMatch(/[—–]/);
  });

  it("returns a distinct (mapped) blurb for every type — none fall through to the default", () => {
    const fallback = getFindingRemediation("DEFINITELY_NOT_A_TYPE");
    for (const type of ALL_TYPES) {
      expect(getFindingRemediation(type)).not.toBe(fallback);
    }
  });

  it.each(ALL_TYPES)("impact line for %s (when present) contains no em-dash or en-dash", (type) => {
    const impact = getFindingImpact(type);
    if (impact !== null) {
      expect(impact).not.toMatch(/[—–]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Agentic "why it matters" impact line
// ---------------------------------------------------------------------------

describe("getFindingImpact — agentic reframe", () => {
  it.each(AGENTIC_IMPACT_TYPES)("returns a non-empty impact line for %s", (type) => {
    const impact = getFindingImpact(type);
    expect(impact).not.toBeNull();
    expect((impact ?? "").trim().length).toBeGreaterThan(0);
  });

  it("returns null for a type with no distinct agent-facing consequence (GHOST_SCRIPT)", () => {
    expect(getFindingImpact("GHOST_SCRIPT")).toBeNull();
  });

  it("does NOT add an impact line for GHOST_PRICE (compare-at pricing, not a JSON-LD signal)", () => {
    expect(getFindingImpact("GHOST_PRICE")).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(getFindingImpact("SOME_FUTURE_TYPE")).toBeNull();
  });

  it("frames JSON_LD_CONFLICT around AI agents picking the wrong data", () => {
    const impact = getFindingImpact("JSON_LD_CONFLICT") ?? "";
    expect(impact.toLowerCase()).toContain("agent");
  });

  it("frames GHOST_OG around AI agents reading a stale price or availability", () => {
    const impact = getFindingImpact("GHOST_OG") ?? "";
    expect(impact.toLowerCase()).toContain("agent");
    expect(impact.toLowerCase()).toMatch(/price|availability/);
  });
});

// ---------------------------------------------------------------------------
// Accuracy spot-checks
// ---------------------------------------------------------------------------

describe("getFindingRemediation — accuracy", () => {
  it("tells merchants to remove a script tag from the theme for GHOST_SCRIPT", () => {
    const blurb = getFindingRemediation("GHOST_SCRIPT");
    expect(blurb.toLowerCase()).toContain("script");
    expect(blurb.toLowerCase()).toContain("theme");
  });

  it("points at Admin URL Redirects (not theme code) for GHOST_REDIRECT", () => {
    const blurb = getFindingRemediation("GHOST_REDIRECT");
    expect(blurb).toContain("URL Redirects");
  });

  it("points at product variants (not theme code) for GHOST_PRICE", () => {
    const blurb = getFindingRemediation("GHOST_PRICE");
    expect(blurb.toLowerCase()).toContain("compare-at");
    expect(blurb.toLowerCase()).toContain("variant");
  });

  it("tells merchants to fix or remove a broken link for DANGLING_REFERENCE", () => {
    const blurb = getFindingRemediation("DANGLING_REFERENCE").toLowerCase();
    expect(blurb).toContain("link");
    expect(blurb).toMatch(/remove|fix/);
  });

  it("warns against hand-editing settings_data.json for SETTINGS_DRIFT", () => {
    const blurb = getFindingRemediation("SETTINGS_DRIFT");
    expect(blurb).toContain("settings_data.json");
  });

  it("does NOT tell merchants to delete a script tag for SETTINGS_DRIFT", () => {
    const blurb = getFindingRemediation("SETTINGS_DRIFT").toLowerCase();
    expect(blurb).not.toContain("script tag");
  });

  it("tells merchants to remove the flagged reference (not just a script line) for MALICIOUS_SCRIPT", () => {
    const blurb = getFindingRemediation("MALICIOUS_SCRIPT").toLowerCase();
    expect(blurb).toContain("reference");
    expect(blurb).toContain("custom liquid");
    expect(blurb).toContain("app block");
    expect(blurb).not.toContain("this script line");
  });

  it("MALICIOUS_SCRIPT never asserts how the code arrived (false for a good-faith reference like polyfill.io)", () => {
    const blurb = getFindingImpact("MALICIOUS_SCRIPT");
    expect(blurb).toContain(
      "it can arrive through a rogue app, a compromised staff account, or older theme or app code that points at a domain that later changed hands.",
    );
    expect(blurb).not.toMatch(/usually arrives|was injected|is compromised/i);
  });

  it("MALICIOUS_SCRIPT impact says 'references', and 'known or credibly reported', for every list entry", () => {
    expect(getFindingImpact("MALICIOUS_SCRIPT")).toBe(
      "This line references a domain known or credibly reported to serve malicious code. Code like this can steal shopper data, inject spam, or redirect customers, and it can arrive through a rogue app, a compromised staff account, or older theme or app code that points at a domain that later changed hands.",
    );
  });

  it("MALICIOUS_SCRIPT how-to: remove the reference first and unconditionally, account steps only if the merchant did not add the code", () => {
    const howTo = getFindingRemediation("MALICIOUS_SCRIPT");
    expect(howTo).toBe(
      "Duplicate your theme as a backup, then remove the reference on the flagged line in the theme code editor. In a JSON template or section, it is usually inside a Custom Liquid block or app block setting; edit or remove that block. For config/settings_data.json, make the change in the theme editor (Customize) instead of editing the JSON by hand. In minified JavaScript, remove only the malicious reference, not the whole line. Search the rest of the theme for the same domain and remove every copy. If you did not add this code yourself, review your installed apps and remove any you do not recognize, check staff accounts and collaborator access, and change your admin passwords; and if you bought the theme from an unofficial source, reinstall a clean copy from the Theme Store or the developer.",
    );
    const condition = howTo.indexOf("If you did not add this code yourself,");
    // Unconditional: everything about removing the reference comes first.
    expect(howTo.indexOf("remove the reference on the flagged line")).toBeLessThan(condition);
    expect(howTo.indexOf("remove every copy")).toBeLessThan(condition);
    // Conditional: every account, app, password and reinstall step comes after.
    for (const step of ["installed apps", "staff accounts", "admin passwords", "reinstall"]) {
      expect(howTo.indexOf(step), step).toBeGreaterThan(condition);
    }
    expect(howTo).not.toMatch(/[–—]/);
  });

  it("APP_EMBED_OFF keeps conditional wording and never asserts install state (gc-fed)", () => {
    const blurb = getFindingRemediation("APP_EMBED_OFF");
    expect(blurb).toContain("If you still use this app");
    expect(blurb).toContain("March 1, 2027");
    expect(blurb).toContain("If you removed this app");
    expect(blurb).not.toMatch(/is (not )?(un)?installed/i);
  });

  it("GHOST_APP_EMBED is conditional and warns against hand-editing settings_data.json (gc-fed)", () => {
    const blurb = getFindingRemediation("GHOST_APP_EMBED");
    expect(blurb).toContain("If you no longer use it");
    expect(blurb).toContain("settings_data.json by hand");
  });

  it("describes the checkout.liquid sunset as past, for every store, for CHECKOUT_SUNSET (gc-oam)", () => {
    const blurb = getFindingRemediation("CHECKOUT_SUNSET");
    expect(blurb).toContain("no longer renders");
    expect(blurb).toContain("August 28, 2025");
    expect(blurb).toContain("Checkout Extensibility");
    expect(blurb).not.toMatch(/2026/);
    expect(blurb).not.toMatch(/hard-block/i);
    expect(blurb).not.toMatch(/\bwill\b/i);
    expect(blurb).not.toMatch(/cutover/i);
    expect(blurb).not.toMatch(/\bPlus\b/);
  });

  it("steers settings_data.json fixes to the theme editor and minified JS to a surgical removal", () => {
    const blurb = getFindingRemediation("MALICIOUS_SCRIPT").toLowerCase();
    expect(blurb).toContain("settings_data.json");
    expect(blurb).toContain("theme editor (customize)");
    expect(blurb).toMatch(/minified/);
    expect(blurb).toContain("not the whole line");
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe("getFindingRemediation — fallback", () => {
  it("returns generic backup guidance for an unknown type", () => {
    const blurb = getFindingRemediation("SOME_FUTURE_TYPE");
    expect(blurb.trim().length).toBeGreaterThan(0);
    expect(blurb.toLowerCase()).toContain("duplicate");
  });

  it("returns the fallback (not a thrown error) for an empty string", () => {
    const blurb = getFindingRemediation("");
    expect(blurb.trim().length).toBeGreaterThan(0);
  });

  it("returns the same fallback string for two different unknown types", () => {
    expect(getFindingRemediation("UNKNOWN_A")).toBe(getFindingRemediation("UNKNOWN_B"));
  });
});

// ---------------------------------------------------------------------------
// buildRemovalInstructions — copy-paste instruction composition
// ---------------------------------------------------------------------------

// The owner's real finding (2026-10-12): the script tag on line 33, stored with
// the comment line above it and the stylesheet line below it.
const KLAVIYO_SNIPPET = [
  "<!-- Orphaned: Klaviyo tracking (app uninstalled 2025-11) -->",
  '    <script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=XXXXXX" async></script>',
  '    <link rel="stylesheet" href="https://a.klaviyo.com/media/css/onsite/onsite.css" />',
].join("\n");
const KLAVIYO_LINE =
  '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=XXXXXX" async></script>';

describe("buildRemovalInstructions", () => {
  it("theme-file finding: names the finding's own line, then labels the snippet as context (exact text)", () => {
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "layout/theme.liquid",
        lineNumber: 33,
        codeSnippet: KLAVIYO_SNIPPET,
      },
      "Scripts",
    );

    expect(out).toBe(
      [
        "GhostCode finding: Scripts",
        "File: layout/theme.liquid  (line 33)",
        "The finding is this line:",
        KLAVIYO_LINE,
        "Code at line 33, shown with the line before and after:",
        KLAVIYO_SNIPPET,
        `How: ${getFindingRemediation("GHOST_SCRIPT")}`,
      ].join("\n"),
    );
    // The neighbouring lines are never labelled as code to remove.
    expect(out).not.toContain("Remove this code");
  });

  it("line 1: the finding's line is the FIRST line of the snippet (exact text)", () => {
    const snippet =
      '<script src="https://cdn.example-app.com/loader.js"></script>\n<div id="app"></div>';
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "layout/theme.liquid",
        lineNumber: 1,
        codeSnippet: snippet,
      },
      "Scripts",
    );
    expect(out).toBe(
      [
        "GhostCode finding: Scripts",
        "File: layout/theme.liquid  (line 1)",
        "The finding is this line:",
        '<script src="https://cdn.example-app.com/loader.js"></script>',
        "Code at line 1, shown with the line before and after:",
        snippet,
        `How: ${getFindingRemediation("GHOST_SCRIPT")}`,
      ].join("\n"),
    );
  });

  it("a one-line file: the line is given once, with no context block that would only repeat it", () => {
    const line = '<script src="https://cdn.example-app.com/loader.js"></script>';
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "snippets/x.liquid",
        lineNumber: 1,
        codeSnippet: `  ${line}`,
      },
      "Scripts",
    );
    expect(out).toBe(
      [
        "GhostCode finding: Scripts",
        "File: snippets/x.liquid  (line 1)",
        "The finding is this line:",
        line,
        `How: ${getFindingRemediation("GHOST_SCRIPT")}`,
      ].join("\n"),
    );
  });

  it("when the finding's line cannot be derived, only the context label is used (no guess)", () => {
    // Line 42 with a one-part snippet: the cap cut it inside the line before.
    const snippet = `<div data-x="${"x".repeat(400)}`.slice(0, 300);
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "layout/theme.liquid",
        lineNumber: 42,
        codeSnippet: snippet,
      },
      "Scripts",
    );
    expect(out).toBe(
      [
        "GhostCode finding: Scripts",
        "File: layout/theme.liquid  (line 42)",
        "Code at line 42, shown with the line before and after:",
        snippet,
        `How: ${getFindingRemediation("GHOST_SCRIPT")}`,
      ].join("\n"),
    );
    expect(out).not.toContain("The finding is this line:");
    expect(out).not.toContain("Remove this code");
  });

  it("no theme-file type ever labels its snippet 'Remove this code'", () => {
    for (const findingType of THEME_FILE_TYPE_SETS.themeFile) {
      for (const lineNumber of [0, 1, 33]) {
        const out = buildRemovalInstructions(
          {
            findingType,
            filename: "layout/theme.liquid",
            lineNumber,
            codeSnippet: KLAVIYO_SNIPPET,
          },
          "T",
        );
        expect(out, `${findingType} line ${lineNumber}`).not.toContain("Remove this code");
      }
    }
  });

  // Snippets NOT built by buildSnippet: a neutral label, no claim about lines.
  it.each([
    ["MALICIOUS_SCRIPT", "assets/app.js", 7, 'fetch("https://jsdeliver.cloud/x.js")'],
    ["GHOST_LAYOUT", "layout/theme.pagefly.liquid", 1, "<!doctype html>\n<html>\n<head>"],
    ["SETTINGS_DRIFT", "config/settings_data.json", 1, '{\n  "abc": {\n    "type": "gone"\n  }\n}'],
    [
      "APP_EMBED_OFF",
      "config/settings_data.json",
      1,
      '{\n  "123": {\n    "disabled": true\n  }\n}',
    ],
    [
      "GHOST_APP_EMBED",
      "config/settings_data.json",
      1,
      '{\n  "123": {\n    "disabled": false\n  }\n}',
    ],
  ])(
    "%s keeps the snippet under a neutral 'Code found:' label (exact text)",
    (findingType, filename, lineNumber, codeSnippet) => {
      const out = buildRemovalInstructions({ findingType, filename, lineNumber, codeSnippet }, "T");
      expect(out).toBe(
        [
          "GhostCode finding: T",
          `File: ${filename}  (line ${lineNumber})`,
          "Code found:",
          codeSnippet,
          `How: ${getFindingRemediation(findingType)}`,
        ].join("\n"),
      );
    },
  );

  it("a line-context type with no real line (lineNumber 0) also gets the neutral label", () => {
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "layout/theme.liquid",
        lineNumber: 0,
        codeSnippet: "<script></script>",
      },
      "Scripts",
    );
    expect(out).toBe(
      [
        "GhostCode finding: Scripts",
        "File: layout/theme.liquid",
        "Code found:",
        "<script></script>",
        `How: ${getFindingRemediation("GHOST_SCRIPT")}`,
      ].join("\n"),
    );
  });

  it("the line-context allow-list covers exactly the theme-file types built by buildSnippet", () => {
    // A new theme-file type must be placed deliberately: on the allow-list only
    // if its detector stores buildSnippet(content, lineNumber) for the row's line.
    const notLineContext = [...THEME_FILE_TYPE_SETS.themeFile]
      .filter((t) => !LINE_CONTEXT_SNIPPET_TYPES.has(t))
      .sort();
    expect(notLineContext).toEqual([
      "APP_EMBED_OFF",
      // A window of the flagged line itself, like MALICIOUS_SCRIPT (gc-14x5).
      "APP_INCIDENT_ADVISORY",
      "GHOST_APP_EMBED",
      "GHOST_LAYOUT",
      "MALICIOUS_SCRIPT",
      "ORPHAN_ASSET",
      "SETTINGS_DRIFT",
    ]);
    for (const t of LINE_CONTEXT_SNIPPET_TYPES) {
      expect(THEME_FILE_TYPE_SETS.themeFile.has(t), t).toBe(true);
    }
  });

  it("uses the FULL snippet, not the 80-char truncation shown in the table", () => {
    const longSnippet = `<script>${"x".repeat(200)}</script>`;
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_SCRIPT",
        filename: "assets/app.js",
        lineNumber: 5,
        codeSnippet: longSnippet,
      },
      "Scripts",
    );
    expect(out).toContain(longSnippet);
    expect(out).not.toContain("…");
  });

  it("degrades gracefully for an Admin-resource finding (no bogus line/snippet)", () => {
    const out = buildRemovalInstructions(
      {
        findingType: "GHOST_PRICE",
        filename: "products/gid://shopify/Product/123",
        lineNumber: 0,
        codeSnippet: "",
      },
      "Compare-at Prices",
    );

    expect(out).toContain("GhostCode finding: Compare-at Prices");
    // No theme line reference and no code block for Admin resources: a
    // plain-language location + the Admin-surface howTo (unchanged, exact).
    expect(out).toBe(
      [
        "GhostCode finding: Compare-at Prices",
        "Location: Product",
        `How: ${getFindingRemediation("GHOST_PRICE")}`,
      ].join("\n"),
    );
  });

  it("omits the line reference when a theme-file finding has lineNumber 0", () => {
    const out = buildRemovalInstructions(
      {
        findingType: "ORPHAN_ASSET",
        filename: "assets/orphan.js",
        lineNumber: 0,
        codeSnippet: "",
      },
      "Orphan Assets",
    );
    expect(out).toContain("File: assets/orphan.js");
    expect(out).not.toContain("(line");
    // Empty snippet → no code block at all.
    expect(out).toBe(
      [
        "GhostCode finding: Orphan Assets",
        "File: assets/orphan.js",
        `How: ${getFindingRemediation("ORPHAN_ASSET")}`,
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// matchedLineFromContextSnippet: the finding's own line, or null (never a guess)
// ---------------------------------------------------------------------------

describe("matchedLineFromContextSnippet", () => {
  // Every snippet here is produced by the REAL buildSnippet, so the derivation
  // is tested against what the scanner actually stores.
  const derive = (content: string, lineNumber: number) =>
    matchedLineFromContextSnippet(buildSnippet(content, lineNumber), lineNumber);

  const FILE = [
    "<head>",
    "  <!-- note -->",
    '  <script src="a.js"></script>',
    "  <link />",
    "</head>",
  ].join("\n");

  it("middle of the file: the second line of the snippet, trimmed", () => {
    expect(buildSnippet(FILE, 3)).toBe(
      '  <!-- note -->\n  <script src="a.js"></script>\n  <link />',
    );
    expect(derive(FILE, 3)).toBe('<script src="a.js"></script>');
  });

  it("first line: the first line of the snippet", () => {
    expect(buildSnippet(FILE, 1)).toBe("<head>\n  <!-- note -->");
    expect(derive(FILE, 1)).toBe("<head>");
  });

  it("last line: the second (and final) line of the snippet", () => {
    expect(buildSnippet(FILE, 5)).toBe("  <link />\n</head>");
    expect(derive(FILE, 5)).toBe("</head>");
  });

  it("single-line file: the whole snippet", () => {
    expect(derive('  <script src="only.js"></script>  ', 1)).toBe(
      '<script src="only.js"></script>',
    );
  });

  it("cap cuts inside the FIRST (previous) line: null, the finding's line is not in the snippet", () => {
    const content = `${"p".repeat(400)}\n<script src="a.js"></script>\nafter`;
    expect(buildSnippet(content, 2)).toBe("p".repeat(300));
    expect(derive(content, 2)).toBeNull();
    // Previous line of exactly 299 chars: its newline is the 300th char.
    expect(derive(`${"p".repeat(299)}\n<script></script>\nafter`, 2)).toBeNull();
  });

  it("cap cuts inside the MATCHED line: null, a partial line is never shown as the finding", () => {
    const content = `before\n<script src="${"u".repeat(400)}"></script>\nafter`;
    const snippet = buildSnippet(content, 2);
    expect(snippet).toHaveLength(300);
    expect(snippet.split("\n")).toHaveLength(2);
    expect(derive(content, 2)).toBeNull();
    // Same on line 1.
    expect(derive(`<script src="${"u".repeat(400)}"></script>\nafter`, 1)).toBeNull();
  });

  it("cap cuts inside the TRAILING line: the matched line is whole, so it is returned", () => {
    const content = `before\n<script src="a.js"></script>\n${"t".repeat(400)}`;
    const snippet = buildSnippet(content, 2);
    expect(snippet).toHaveLength(300);
    expect(derive(content, 2)).toBe('<script src="a.js"></script>');
  });

  it("matched line ends exactly at the cap: whole only when its newline also fits", () => {
    const before = "b".repeat(100);
    // before(100) + \n + matched(198) + \n = 300: the newline proves the line is whole.
    const fits = "m".repeat(198);
    expect(derive(`${before}\n${fits}\nafter`, 2)).toBe(fits);
    // matched(199) ends at char 300 and its newline is cut: could be partial, so null.
    expect(derive(`${before}\n${"m".repeat(199)}\nafter`, 2)).toBeNull();
    // Last line of a file, snippet exactly at the cap: indistinguishable from a cut, so null.
    expect(derive(`${before}\n${"m".repeat(199)}`, 2)).toBeNull();
    // One character shorter is provably whole.
    expect(derive(`${before}\n${fits}`, 2)).toBe(fits);
  });

  it("a matched line longer than 300 characters is never returned", () => {
    const long = `<script>${"x".repeat(500)}</script>`;
    expect(derive(long, 1)).toBeNull();
    expect(derive(`a\n${long}\nb`, 2)).toBeNull();
    expect(derive(`a\n${long}`, 2)).toBeNull();
  });

  it("CRLF line endings: the carriage return is trimmed off", () => {
    const content = '<head>\r\n  <script src="a.js"></script>\r\n</head>\r\n';
    expect(derive(content, 2)).toBe('<script src="a.js"></script>');
    expect(derive(content, 1)).toBe("<head>");
    expect(derive(content, 3)).toBe("</head>");
  });

  it("CR-only line endings (one 'line' holding several): null", () => {
    expect(derive('<head>\r<script src="a.js"></script>\r</head>', 1)).toBeNull();
  });

  it("blank neighbouring lines do not shift the index", () => {
    const content = '<head>\n\n<script src="a.js"></script>\n\n</head>';
    expect(buildSnippet(content, 3)).toBe('\n<script src="a.js"></script>\n');
    expect(derive(content, 3)).toBe('<script src="a.js"></script>');
    // Whitespace-only neighbours too.
    expect(derive('a\n   \n<script src="a.js"></script>\n\t\nb', 3)).toBe(
      '<script src="a.js"></script>',
    );
    // Blank line after line 1.
    expect(derive("<script></script>\n\nx", 1)).toBe("<script></script>");
  });

  it("a blank matched line, or an invalid line number, is null", () => {
    expect(derive("a\n   \nb", 2)).toBeNull();
    expect(matchedLineFromContextSnippet("a\nb\nc", 0)).toBeNull();
    expect(matchedLineFromContextSnippet("a\nb\nc", -1)).toBeNull();
    expect(matchedLineFromContextSnippet("a\nb\nc", 2.5)).toBeNull();
    expect(matchedLineFromContextSnippet("", 1)).toBeNull();
    // Line >= 2 needs a second part.
    expect(matchedLineFromContextSnippet("only one line", 2)).toBeNull();
  });

  it("for every line of varied files, the result is that exact line trimmed, or null", () => {
    const widths = [
      0, 1, 40, 97, 98, 99, 100, 148, 149, 150, 151, 199, 200, 298, 299, 300, 301, 450,
    ];
    let derived = 0;
    for (const eol of ["\n", "\r\n"]) {
      for (let seed = 0; seed < widths.length; seed++) {
        const fileLines = Array.from({ length: 6 }, (_, i) => {
          const width = widths[(seed + i * 5) % widths.length];
          return `${i}`.repeat(width);
        });
        const content = fileLines.join(eol);
        fileLines.forEach((text, i) => {
          const got = derive(content, i + 1);
          if (got !== null) {
            derived++;
            expect(got, `seed ${seed} line ${i + 1}`).toBe(text);
          }
        });
      }
    }
    expect(derived).toBeGreaterThan(50);
  });
});

describe("findingMatchedLine", () => {
  it("derives the line only for types whose snippet is buildSnippet line context", () => {
    const base = { lineNumber: 33, codeSnippet: KLAVIYO_SNIPPET };
    expect(findingMatchedLine({ ...base, findingType: "GHOST_SCRIPT" })).toBe(KLAVIYO_LINE);
    for (const findingType of [
      "MALICIOUS_SCRIPT",
      "GHOST_LAYOUT",
      "SETTINGS_DRIFT",
      "APP_EMBED_OFF",
      "GHOST_APP_EMBED",
      "ORPHAN_ASSET",
      "GHOST_PAGE",
      "SCRIPT_TAG_SUNSET",
      "LIQUID_ERROR_RENDERED",
      "SOME_FUTURE_TYPE",
    ]) {
      expect(findingMatchedLine({ ...base, findingType }), findingType).toBeNull();
    }
  });
});

describe("SCRIPT_TAG_SUNSET guidance (storefront, merchant cannot delete)", () => {
  const finding = {
    findingType: "SCRIPT_TAG_SUNSET",
    filename: "storefront/script-tags",
    lineNumber: 1,
    codeSnippet: "https://cdn.example.com/a.js\nhttps://cdn.example.com/b.js",
  };

  it("points at the vendor and the App embeds settings, never at deleting anything", () => {
    const howTo = getFindingRemediation("SCRIPT_TAG_SUNSET");
    expect(howTo).toContain("support");
    expect(howTo).toContain("App embeds");
    expect(howTo).toContain("March 1, 2027");
    expect(howTo).toMatch(/nothing for you to delete/);
    expect(howTo).not.toMatch(/[—–]/);
  });

  it("removal instructions list the URLs without a 'Remove this code' or file/line block", () => {
    const text = buildRemovalInstructions(finding, "Script Tag Sunset");
    expect(text).toBe(
      [
        "GhostCode finding: Script Tag Sunset",
        "Location: your storefront's script tags (not in your theme code)",
        "Script tag URLs:",
        "https://cdn.example.com/a.js",
        "https://cdn.example.com/b.js",
        `How: ${getFindingRemediation("SCRIPT_TAG_SUNSET")}`,
      ].join("\n"),
    );
    expect(text).not.toContain("Remove this code");
    expect(text).not.toContain("File:");
    expect(text).toContain(`How: ${getFindingRemediation("SCRIPT_TAG_SUNSET")}`);
  });
});

describe("LIQUID_ERROR_RENDERED guidance (gc-i6du: read from the homepage, fixed in the theme)", () => {
  const finding = {
    findingType: "LIQUID_ERROR_RENDERED",
    filename: "storefront/homepage",
    lineNumber: 1,
    codeSnippet:
      "Liquid error in layout/theme: Could not find asset snippets/klaviyo-form.liquid\nLiquid error (layout/theme line 309): Could not find asset snippets/klaviyo-form.liquid",
  };

  it("tells the merchant where to fix it: the file and line the error names", () => {
    const howTo = getFindingRemediation("LIQUID_ERROR_RENDERED");
    expect(howTo).toContain("Open the theme file the error names");
    expect(howTo).toContain("delete the render line");
    expect(howTo).toContain("ask its support how to add it back");
    expect(howTo).toContain("Duplicate your live theme first");
    expect(howTo).not.toContain("\u2014");
  });

  it("the copyable instruction shows the error as shoppers see it, not the internal identity line", () => {
    const text = buildRemovalInstructions(finding, "Liquid Errors on Your Homepage");
    expect(text.split("\n")).toEqual([
      "GhostCode finding: Liquid Errors on Your Homepage",
      "Location: your storefront homepage (it can be inside a menu or a hidden section)",
      "Error shown:",
      "Liquid error (layout/theme line 309): Could not find asset snippets/klaviyo-form.liquid",
      `How: ${getFindingRemediation("LIQUID_ERROR_RENDERED")}`,
    ]);
    expect(text).not.toContain("Liquid error in layout/theme");
    expect(text).not.toContain("script tags");
    expect(text).not.toContain("Remove this code");
  });

  it("a row with only the identity line still yields a location and the how-to", () => {
    const text = buildRemovalInstructions({ ...finding, codeSnippet: "Liquid error: x" }, "L");
    expect(text).not.toContain("Error shown:");
    expect(text).toContain("How: ");
  });
});
