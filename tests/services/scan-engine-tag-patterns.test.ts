/**
 * Equivalence guard for execTagPattern (gc-t7x).
 *
 * The tag detectors used to run these regexes on each extracted tag. They
 * backtrack quadratically on a huge tag (many inner `<link` starts, or many
 * candidate attribute positions), so execTagPattern evaluates them in linear
 * time instead. This file pins two things:
 *   1. Each pattern's regex source is exactly the regex it replaced, so the
 *      structured pattern is a faithful transcription. (FONT_LINK_TAG's second
 *      alternative is the one deliberate rewrite: it is pinned to its new
 *      source and checked for equivalence with the old regex instead.)
 *   2. On a seeded corpus of random tags built from attribute fragments,
 *      execTagPattern returns exactly what the regex's exec returns (index,
 *      full match and every capture group).
 */

import { describe, expect, it } from "vitest";

import { AI_CRAWLER_USER_AGENTS } from "../../app/data/ai-crawlers.server";
import { TAG_PATTERNS, execTagPattern } from "../../app/services/scan-engine.server";

const ROBOTS_NAMES = ["robots", ...AI_CRAWLER_USER_AGENTS].join("|");

// The regexes as they were before gc-t7x (copied verbatim from the old source).
const ORIGINAL_REGEXES: Record<keyof typeof TAG_PATTERNS, RegExp> = {
  SCRIPT_SRC_TAG: /<script[^>]+src\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*>/gi,
  LINK_STYLESHEET_TAG:
    /<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*>|<link[^>]+href\s*=\s*["']((https?:)?\/\/[^"']+)["'][^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi,
  HREFLANG_TAG_1:
    /<link[^>]+rel\s*=\s*["']alternate["'][^>]+hreflang\s*=\s*["']([^"']+)["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi,
  HREFLANG_TAG_2:
    /<link[^>]+rel\s*=\s*["']alternate["'][^>]+href\s*=\s*["']([^"']+)["'][^>]*hreflang\s*=\s*["']([^"']+)["'][^>]*>/gi,
  META_TAG: /<meta\s+[^>]*(?:name|property)\s*=\s*["']([^"']+)["'][^>]*>/gi,
  META_ROBOTS_TAG: new RegExp(
    `<meta\\s+[^>]*name\\s*=\\s*["'](?:${ROBOTS_NAMES})["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>|<meta\\s+[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*name\\s*=\\s*["'](?:${ROBOTS_NAMES})["'][^>]*>`,
    "gi",
  ),
  CANONICAL_TAG:
    /<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*>|<link[^>]+href\s*=\s*["']([^"']*)["'][^>]*rel\s*=\s*["']canonical["'][^>]*>/gi,
  OG_META_TAG:
    /<meta\s+[^>]*(?:property\s*=\s*["'](og:[^"']+)["']|name\s*=\s*["'](twitter:[^"']+)["'])[^>]*>/gi,
  PRECONNECT_TAG:
    /<link[^>]+rel\s*=\s*["'](preconnect|dns-prefetch|preload)["'][^>]+href\s*=\s*["']([^"']+)["'][^>]*>|<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["'](preconnect|dns-prefetch|preload)["'][^>]*>/gi,
  FONT_LINK_TAG:
    /<link[^>]+href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>|<link[^>]+href\s*=\s*["'](https?:\/\/[^"']*font[^"']*)["'][^>]*>/gi,
};

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

// Fragments that exercise every attribute sub-pattern, near misses, case and
// whitespace variants, inner tag starts, and quote/`>` edge cases.
const FRAGMENTS = [
  " ",
  "\n",
  "\t",
  "=",
  " = ",
  '"',
  "'",
  "x",
  "/",
  "//",
  "https:",
  "http://",
  "HTTPS://",
  "<link",
  "<LINK",
  "<meta",
  "<Meta ",
  "<script",
  "<script ",
  "rel",
  "REL",
  "href",
  "hreflang",
  "src",
  "name",
  "property",
  "content",
  '"stylesheet"',
  "'stylesheet'",
  '"alternate"',
  '"canonical"',
  '"preconnect"',
  "'dns-prefetch'",
  '"preload"',
  '"og:title"',
  "'twitter:card'",
  '"robots"',
  '"GPTBot"',
  "'noindex'",
  '"//cdn.example.com/a.css"',
  '"https://fonts.googleapis.com/css"',
  '"https://x.example/myfont.woff"',
  '"fr"',
  '""',
  "fonts.googleapis.com/",
  "font",
];

// Whole attributes (and near misses) so that every pattern, including the
// three-attribute hreflang ones, matches a meaningful share of the corpus.
const ATTRIBUTES = [
  ' rel="stylesheet"',
  " REL = 'stylesheet'",
  ' rel="alternate"',
  " rel='canonical'",
  ' rel="preconnect"',
  ' rel="dns-prefetch"',
  ' rel="preload"',
  ' href="//cdn.example.com/a.css"',
  ' href="https://a.b/c"',
  " href='http://x.example/font.woff'",
  ' href="https://fonts.googleapis.com/css?f=A"',
  ' href=""',
  ' href="rel=stylesheet"',
  ' hreflang="fr"',
  " hreflang='x-default'",
  ' src="//a.b/x.js"',
  ' SRC = "https://c.d/e"',
  ' src="/local.js"',
  ' name="robots"',
  " name='GPTBot'",
  ' name="description"',
  ' name="twitter:card"',
  ' property="og:title"',
  ' content="noindex"',
  " content='x'",
  ' content=""',
  " rel=stylesheet",
  ' href="',
  " <link",
  " <meta",
  " <script",
];

function randomTag(rand: () => number): string {
  const opener = ["<link", "<meta", "<script", "<LINK", "<meta ", "x<link "][
    Math.floor(rand() * 6)
  ];
  let tag = opener;
  const parts = Math.floor(rand() * 12);
  for (let i = 0; i < parts; i++) {
    const pool = rand() < 0.6 ? ATTRIBUTES : FRAGMENTS;
    tag += pool[Math.floor(rand() * pool.length)];
  }
  // Tags from extractTags end at their first `>`, so the body has none.
  return tag.replace(/>/g, "") + ">";
}

function snapshot(match: RegExpExecArray | null): unknown {
  return match === null ? null : { index: match.index, values: [...match] };
}

// Patterns whose structured form was rewritten on purpose (so their source no
// longer equals the regex they replaced) mapped to the regex they now encode.
// Their behavior is still pinned to ORIGINAL_REGEXES by the random-corpus test.
const REWRITTEN_SOURCES: Partial<Record<keyof typeof TAG_PATTERNS, RegExp>> = {
  // The catch-all alternative `(https?:\/\/[^"']*font[^"']*)["']` rescanned to
  // the end of the tag for every `font` when the closing quote was missing. The
  // lookahead requires `font` somewhere in the value (the value runs to the
  // first quote either way) with a single forward scan.
  FONT_LINK_TAG:
    /<link[^>]+href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>|<link[^>]+href\s*=\s*["'](?=https?:\/\/[^"']*?font)(https?:\/\/[^"']*)["'][^>]*>/gi,
};

describe("execTagPattern", () => {
  it.each(Object.keys(ORIGINAL_REGEXES) as Array<keyof typeof TAG_PATTERNS>)(
    "%s has exactly the source of the regex it replaced (or its pinned rewrite)",
    (name) => {
      const expected = REWRITTEN_SOURCES[name] ?? ORIGINAL_REGEXES[name];
      expect(TAG_PATTERNS[name].source).toBe(expected.source);
    },
  );

  it.each(Object.keys(REWRITTEN_SOURCES) as Array<keyof typeof TAG_PATTERNS>)(
    "%s's rewritten regex matches exactly like the regex it replaced on 20K random tags",
    (name) => {
      const rand = prng(0x5eed + name.length);
      const original = ORIGINAL_REGEXES[name];
      const rewritten = REWRITTEN_SOURCES[name]!;
      let matches = 0;
      for (let i = 0; i < 20_000; i++) {
        const tag = randomTag(rand);
        original.lastIndex = 0;
        rewritten.lastIndex = 0;
        const expected = snapshot(original.exec(tag));
        const actual = snapshot(rewritten.exec(tag));
        if (expected !== null) matches++;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          expect({ tag, actual }).toEqual({ tag, actual: expected });
        }
      }
      expect(matches).toBeGreaterThan(10);
    },
  );

  it.each([
    ['<link href="https://fonts.example.net/abc.css">', "https://fonts.example.net/abc.css"],
    ['<link href="http://x.example/FONT.woff" rel="x">', "http://x.example/FONT.woff"],
    ["<link rel='x' href='https://a.example/fonts/b'>", "https://a.example/fonts/b"],
    ['<link href="https://font">', "https://font"],
    // `font` must be inside the value: text after the closing quote is ignored.
    ['<link href="https://a.example/x.css" data-font="1">', null],
    ['<link href="https://a.example/x.css">', null],
    ['<link href="//a.example/font.css">', null],
    ['<link href="https://a.example/font.css>', null],
    // The rightmost matching href wins, as with the greedy `[^>]+` gap.
    [
      '<link href="https://a.example/font1" href="https://b.example/font2">',
      "https://b.example/font2",
    ],
    ['<link href="https://a.example/font1" href="https://b.example/x">', "https://a.example/font1"],
  ])("FONT_LINK_TAG catch-all alternative on %s", (tag, href) => {
    const original = ORIGINAL_REGEXES.FONT_LINK_TAG;
    original.lastIndex = 0;
    const expected = original.exec(tag);
    const actual = execTagPattern(tag, TAG_PATTERNS.FONT_LINK_TAG);
    expect(snapshot(actual)).toEqual(snapshot(expected));
    expect(actual?.[2] ?? null).toBe(href);
  });

  it("FONT_LINK_TAG is linear on a huge href with many `font`s and no closing quote", () => {
    // 1 MB took > 25s with the old catch-all alternative.
    const tag = '<link href="https://' + "font".repeat(250_000) + ">";
    const start = performance.now();
    expect(execTagPattern(tag, TAG_PATTERNS.FONT_LINK_TAG)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it.each(Object.keys(ORIGINAL_REGEXES) as Array<keyof typeof TAG_PATTERNS>)(
    "%s matches exactly like the regex on 20K random tags",
    (name) => {
      const rand = prng(0x7a9 + name.length);
      const regex = ORIGINAL_REGEXES[name];
      let matches = 0;
      for (let i = 0; i < 20_000; i++) {
        const tag = randomTag(rand);
        regex.lastIndex = 0;
        const expected = snapshot(regex.exec(tag));
        const actual = snapshot(execTagPattern(tag, TAG_PATTERNS[name]));
        if (expected !== null) matches++;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          // Surface the offending tag in the failure message.
          expect({ tag, actual }).toEqual({ tag, actual: expected });
        }
      }
      // Not vacuous: the corpus exercises the matching path too.
      expect(matches).toBeGreaterThan(10);
    },
  );

  it("returns groups at the regex's group numbers for a second alternative", () => {
    const match = execTagPattern(
      '<link href="//cdn.example.com/a.css" rel="stylesheet">',
      TAG_PATTERNS.LINK_STYLESHEET_TAG,
    );
    expect(match?.index).toBe(0);
    expect(match?.[1]).toBeUndefined();
    expect(match?.[3]).toBe("//cdn.example.com/a.css");
  });

  it("returns null when no alternative matches", () => {
    expect(execTagPattern('<link rel="icon" href="/a.png">', TAG_PATTERNS.CANONICAL_TAG)).toBe(
      null,
    );
  });
});
