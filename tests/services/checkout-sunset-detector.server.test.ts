/**
 * Unit tests for the checkout-extensibility sunset detector (gc-b3c).
 *
 * The detector is PURE: it reads only the already-fetched theme files and emits
 * at most one CHECKOUT_SUNSET finding.
 *
 * Coverage:
 *   - happy path: checkout.liquid with scripts → one finding, subtype "scripts"
 *   - depth subtypes: tracking / snippets / content-injection / plain layout
 *   - edge: no checkout.liquid → no finding
 *   - edge: empty / whitespace / comment-only checkout.liquid → no finding
 *   - commented-out signals are not counted as live customization
 *   - finding shape: filename, type, HIGH severity, evidence snippet, subtype tag
 *   - comment stripping is linear on unterminated comment floods (gc-4yg) and
 *     identical to the regexes it replaced on random input
 *   - checkout.liquid over MAX_SCANNABLE_FILE_BYTES: presence finding only
 *   - sunset copy is past tense and accurate for every store (gc-oam)
 */

import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  detectCheckoutSunset,
  stripComments,
} from "../../app/services/checkout-sunset-detector.server";
import { MAX_SCANNABLE_FILE_BYTES, type ThemeFile } from "../../app/services/scan-engine.server";

const CHECKOUT_PATH = "layout/checkout.liquid";

function file(content: string, filename = CHECKOUT_PATH): ThemeFile {
  return { filename, content };
}

// ---------------------------------------------------------------------------
// Check 1 — presence (with non-trivial content)
// ---------------------------------------------------------------------------

describe("detectCheckoutSunset — presence check", () => {
  it("emits no finding when layout/checkout.liquid is absent", () => {
    const findings = detectCheckoutSunset([
      file("<div>hi</div>", "layout/theme.liquid"),
      file("{{ content_for_layout }}", "sections/header.liquid"),
    ]);
    expect(findings).toEqual([]);
  });

  it("emits no finding for an empty checkout.liquid", () => {
    expect(detectCheckoutSunset([file("")])).toEqual([]);
  });

  it("emits no finding for a whitespace-only checkout.liquid", () => {
    expect(detectCheckoutSunset([file("\n\n   \t\n")])).toEqual([]);
  });

  it("emits no finding when checkout.liquid holds only comments", () => {
    const content = "{% comment %} old checkout {% endcomment %}\n<!-- legacy -->";
    expect(detectCheckoutSunset([file(content)])).toEqual([]);
  });

  it("emits exactly one finding for a non-trivial checkout.liquid", () => {
    const findings = detectCheckoutSunset([file("{{ content_for_layout }}")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.CHECKOUT_SUNSET);
    expect(findings[0].filename).toBe(CHECKOUT_PATH);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("matches only the exact layout/checkout.liquid path, not lookalikes", () => {
    const findings = detectCheckoutSunset([
      file("<script>track()</script>", "snippets/checkout.liquid"),
      file("<script>track()</script>", "templates/checkout.liquid"),
    ]);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Check 2 — customization depth (subtype + description)
// ---------------------------------------------------------------------------

describe("detectCheckoutSunset — customization depth", () => {
  it('tags subtype "scripts" and describes script breakage for a <script> tag', () => {
    const findings = detectCheckoutSunset([
      file('<script src="https://cdn.example.com/x.js"></script>'),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("scripts");
    expect(findings[0].description).toContain("custom <script> code no longer runs");
    expect(findings[0].description).toContain("Checkout Extensibility");
  });

  it('tags subtype "tracking" for analytics snippets (no <script> tag)', () => {
    const findings = detectCheckoutSunset([file("{{ 'x' }} gtag('config', 'GA-1');")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("tracking");
    expect(findings[0].description).toContain("tracking and analytics pixels no longer fire");
  });

  it('tags subtype "snippets" for a {% render %} with no scripts/tracking', () => {
    const findings = detectCheckoutSunset([file("{% render 'checkout-extras' %}")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("snippets");
    expect(findings[0].description).toContain("custom snippets rendered into checkout");
  });

  it('tags subtype "content-injection" for content_for_* only', () => {
    const findings = detectCheckoutSunset([
      file("{{ content_for_header }}\n{{ content_for_layout }}"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("content-injection");
    expect(findings[0].description).toContain("content_for_*");
  });

  it('tags subtype "layout" for a non-trivial file with no recognized signals', () => {
    const findings = detectCheckoutSunset([file("<div class='wrap'>Checkout</div>")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("layout");
    // The generic (no-signal) description omits the "What breaks:" enumeration.
    expect(findings[0].description).not.toContain("What stopped working:");
    expect(findings[0].description).toContain("Checkout Extensibility");
  });

  it("picks the highest-impact subtype and lists every matching clause", () => {
    // scripts + render + content_for all present → subtype is the top-priority
    // "scripts", but the description enumerates all three.
    const content = [
      "{{ content_for_header }}",
      "{% render 'extras' %}",
      "<script>fbq('track', 'Purchase');</script>",
    ].join("\n");
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("scripts");
    expect(findings[0].description).toContain("custom <script> code no longer runs");
    expect(findings[0].description).toContain("custom snippets rendered into checkout");
    expect(findings[0].description).toContain("content_for_*");
  });

  it("does not count a commented-out <script> as a live customization", () => {
    // Only a commented script + one live content_for injection point.
    const content = "<!-- <script>old()</script> -->\n{{ content_for_layout }}";
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    // The live signal is content_for, not the commented script.
    expect(findings[0].appName).toBe("content-injection");
    expect(findings[0].description).not.toContain("<script> code no longer runs");
  });
});

// ---------------------------------------------------------------------------
// Finding evidence
// ---------------------------------------------------------------------------

describe("detectCheckoutSunset — evidence", () => {
  it("anchors the snippet at the first line carrying a detected signal", () => {
    const content = ["<p>hi</p>", "<script>go()</script>", "<p>bye</p>"].join("\n");
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    // The only signal is the <script> on line 2.
    expect(findings[0].lineNumber).toBe(2);
    expect(findings[0].codeSnippet).toContain("<script>go()</script>");
  });

  it("falls back to line 1 for a plain layout file with no signals", () => {
    const findings = detectCheckoutSunset([file("<div>Checkout</div>")]);
    expect(findings[0].lineNumber).toBe(1);
  });

  it("anchors evidence at the LIVE signal, not an earlier commented occurrence", () => {
    // <script> appears first inside an HTML comment (line 1) and again as live
    // code (line 5). The evidence must resolve to the live line, so the finding
    // never shows commented-out code as proof of a live-breakage claim.
    const content = [
      "<!-- <script>legacyThing()</script> -->",
      "{{ content_for_layout }}",
      "<p>filler</p>",
      "<p>filler</p>",
      "<script>trackingPixel()</script>",
    ].join("\n");
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    // Dominant signal is "scripts"; evidence anchors at the live script (line 5),
    // not the commented one (line 1).
    expect(findings[0].appName).toBe("scripts");
    expect(findings[0].lineNumber).toBe(5);
    expect(findings[0].codeSnippet).toContain("trackingPixel()");
    expect(findings[0].codeSnippet).not.toContain("legacyThing()");
  });

  it("emits no em-dash or en-dash in the description", () => {
    const findings = detectCheckoutSunset([file("<script>x()</script>")]);
    expect(findings[0].description).not.toMatch(/[—–]/);
  });
});

// ---------------------------------------------------------------------------
// gc-4yg — comment stripping is linear and unchanged
// ---------------------------------------------------------------------------

// The comment-stripping regexes as they were before gc-4yg (copied verbatim).
const OLD_LIQUID_COMMENT_RE = /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/gi;
const OLD_HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function oldStripComments(content: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return content.replace(OLD_LIQUID_COMMENT_RE, blank).replace(OLD_HTML_COMMENT_RE, blank);
}

// Deterministic PRNG (mulberry32) so a failure is reproducible.
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Delimiter pieces, near misses, case and whitespace variants, and nesting.
const COMMENT_FRAGMENTS = [
  "{%",
  "{%-",
  "%}",
  "-%}",
  " ",
  "  ",
  "\n",
  "\t",
  "comment",
  "COMMENT",
  "endcomment",
  "EndComment",
  "{% comment %}",
  "{% endcomment %}",
  "{%- comment -%}",
  "{%-endcomment-%}",
  "{%comment%}",
  "{% endcomment",
  "<!--",
  "-->",
  "<!-->",
  "<!--->",
  "--",
  "-",
  "<!-",
  "->",
  "<",
  ">",
  "!",
  "x",
  "<script>",
  "{{ a }}",
];

function randomCommentSoup(rand: () => number): string {
  let out = "";
  const parts = Math.floor(rand() * 16);
  for (let i = 0; i < parts; i++) {
    out += COMMENT_FRAGMENTS[Math.floor(rand() * COMMENT_FRAGMENTS.length)];
  }
  return out;
}

// At the per-file cap the old regexes took > 20s; the linear scan takes ms.
function atCap(fragment: string, prefix = ""): string {
  const body = MAX_SCANNABLE_FILE_BYTES - prefix.length;
  return prefix + fragment.repeat(Math.ceil(body / fragment.length)).slice(0, body);
}

describe("stripComments (gc-4yg)", () => {
  it("returns exactly what the old regexes returned on 50K random inputs", () => {
    const rand = prng(0x4f9);
    let changed = 0;
    for (let i = 0; i < 50_000; i++) {
      const content = randomCommentSoup(rand);
      const expected = oldStripComments(content);
      const actual = stripComments(content);
      if (expected !== content) changed++;
      if (actual !== expected) {
        // Surface the offending input in the failure message.
        expect({ content, actual }).toEqual({ content, actual: expected });
      }
    }
    // Not vacuous: a good share of the corpus actually contains comments.
    expect(changed).toBeGreaterThan(5_000);
  });

  it.each([
    ["an unclosed Liquid comment", "a {% comment %} b\nc"],
    ["an unclosed HTML comment", "a <!-- b\nc"],
    ["a Liquid comment wrapping an HTML opener", "{% comment %}<!--{% endcomment %}x-->y"],
    ["an HTML comment wrapping a Liquid opener", "<!--{% comment %}-->x{% endcomment %}"],
    ["a self-overlapping <!-->", "<!-->x-->y"],
    ["whitespace-controlled delimiters", "{%- COMMENT -%}\n<script>\n{%-endcomment-%}z"],
    ["a later closer after an unclosed opener", "{% comment %}a{% comment %}b{% endcomment %}c"],
  ])("matches the old regexes on %s", (_label, content) => {
    expect(stripComments(content)).toBe(oldStripComments(content));
  });

  it("keeps the length and every newline", () => {
    const content = "a\n{% comment %}\nb\n{% endcomment %}\n<!--\nc-->d";
    const stripped = stripComments(content);
    expect(stripped).toHaveLength(content.length);
    expect(stripped.split("\n")).toHaveLength(content.split("\n").length);
    expect(stripped).toBe("a\n" + " ".repeat(13) + "\n \n" + " ".repeat(16) + "\n    \n    d");
  });
});

describe("detectCheckoutSunset — linear on unterminated comment floods (gc-4yg)", () => {
  // Runs on the MAIN thread in the scan-theme step (not the scan worker), so a
  // quadratic scan here stalls the whole multi-tenant process.
  it.each([
    ["<!-- openers with no -->", atCap("<!--")],
    ["{% comment %} openers with no endcomment", atCap("{% comment %}", "<p>x</p>")],
    ["{%- comment -%} openers on separate lines", atCap("{%- comment -%}\n", "<p>x</p>")],
  ])("%s", (_label, content) => {
    const start = performance.now();
    const findings = detectCheckoutSunset([file(content)]);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(findings).toHaveLength(1);
  });
});

describe("detectCheckoutSunset — checkout.liquid over MAX_SCANNABLE_FILE_BYTES", () => {
  const oversized = "<script>track()</script>\n" + " ".repeat(MAX_SCANNABLE_FILE_BYTES);

  it("still emits the presence finding, without customization analysis", () => {
    const findings = detectCheckoutSunset([file(oversized)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.CHECKOUT_SUNSET);
    expect(findings[0].severity).toBe(Severity.HIGH);
    expect(findings[0].filename).toBe(CHECKOUT_PATH);
    // No depth analysis ran, so no specific breakage is claimed.
    expect(findings[0].appName).toBe("layout");
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].description).toContain("still includes checkout.liquid");
    expect(findings[0].description).not.toContain("What stopped working");
    expect(findings[0].codeSnippet).toContain("<script>track()</script>");
  });

  it("does not analyze an oversized file's content (an all-comment file still flags)", () => {
    const allComments = atCap("<!--") + "<!--";
    expect(allComments.length).toBeGreaterThan(MAX_SCANNABLE_FILE_BYTES);
    const start = performance.now();
    const findings = detectCheckoutSunset([file(allComments)]);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(findings).toHaveLength(1);
  });

  it("analyzes a file exactly at the cap as usual", () => {
    const content = "<script>track()</script>" + " ".repeat(MAX_SCANNABLE_FILE_BYTES - 24);
    expect(content).toHaveLength(MAX_SCANNABLE_FILE_BYTES);
    expect(detectCheckoutSunset([file(content)])[0].appName).toBe("scripts");
  });
});

// ---------------------------------------------------------------------------
// gc-oam — sunset copy is past tense and true for every store
// ---------------------------------------------------------------------------

describe("detectCheckoutSunset — sunset copy accuracy (gc-oam)", () => {
  // One description per copy path: a single signal, several signals, the
  // generic no-signal layout, and the oversized (unanalyzed) file.
  const variants: Array<[string, string]> = [
    ["scripts", "<script>x()</script>"],
    ["multi-signal", "<script>x()</script>\n{% render 'a' %}\n{{ content_for_header }}"],
    ["layout", "<div>Checkout</div>"],
    ["oversized", "a".repeat(MAX_SCANNABLE_FILE_BYTES + 1)],
  ];

  it.each(variants)("%s description states the sunset has already happened", (_name, content) => {
    const description = detectCheckoutSunset([file(content)])[0].description;
    expect(description).toContain("no longer renders");
    expect(description).toContain("August 28, 2025");
    expect(description).toContain("Checkout Extensibility");
  });

  it.each(variants)("%s description makes no future-dated or Plus-only claim", (_name, content) => {
    const description = detectCheckoutSunset([file(content)])[0].description;
    expect(description).not.toMatch(/2026/);
    expect(description).not.toMatch(/hard-block/i);
    expect(description).not.toMatch(/\bwill\b/i);
    expect(description).not.toMatch(/after that/i);
    expect(description).not.toMatch(/cutover/i);
    expect(description).not.toMatch(/\bPlus\b/);
    expect(description).not.toMatch(/[—–]/);
  });

  // A file that "no longer renders" cannot still be customizing checkout: the
  // signal copy describes leftover customizations, not a live mechanism.
  it.each(variants.slice(0, 2))(
    "%s description says the theme contains customizations, not that it customizes checkout",
    (_name, content) => {
      const description = detectCheckoutSunset([file(content)])[0].description;
      expect(description).toMatch(/^Your theme still contains checkout\.liquid customizations\. /);
      expect(description).not.toMatch(/uses checkout\.liquid to customize/);
    },
  );
});
