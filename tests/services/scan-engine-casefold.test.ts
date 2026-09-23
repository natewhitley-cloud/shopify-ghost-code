import { describe, expect, it } from "vitest";

import {
  detectDuplicateMetaTags,
  detectGhostScripts,
  detectGhostStyles,
  detectMaliciousScripts,
  indexOfIgnoreCase,
} from "../../app/services/scan-engine.server";

// Regression guard for gc-8jd. Tag starts (and the malicious-domain snippet
// anchor) used to be found by lowercasing the WHOLE string and reusing the
// offsets on the original. String.prototype.toLowerCase is not length
// preserving: U+0130 (İ) lowercases to "i" + U+0307, so every offset after an
// İ drifted by one and the later tags were mis-sliced (dropped) or snipped in
// the wrong place.

const KLAVIYO_SCRIPT = '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>';
const KLAVIYO_STYLE = '<link rel="stylesheet" href="https://static.klaviyo.com/onsite/a.css">';

// Every BMP/astral code point whose toLowerCase() changes length. The fix's
// correctness argument relies on this list, so pin it: a new Unicode version
// that adds one should fail here and get a test below.
describe("length-changing lowercase characters", () => {
  it("is exactly U+0130 across all code points", () => {
    const found: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (c.toLowerCase().length !== c.length) found.push(cp);
    }
    expect(found).toEqual([0x0130]);
  });

  it("maps only A-Z and U+212A (Kelvin) from another code unit onto ASCII", () => {
    const toAscii: number[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const lower = String.fromCharCode(c).toLowerCase();
      if (lower.length === 1 && lower.charCodeAt(0) < 128 && lower.charCodeAt(0) !== c) {
        toAscii.push(c);
      }
    }
    const aToZ = Array.from({ length: 26 }, (_, i) => 65 + i);
    expect(toAscii).toEqual([...aToZ, 0x212a]);
  });
});

describe("indexOfIgnoreCase", () => {
  it("returns the offset in the ORIGINAL string after an İ", () => {
    const s = "İ<SCRIPT src=x>";
    expect(indexOfIgnoreCase(s, "<script")).toBe(1);
    // The old whole-string lowercase reported 2 here.
    expect(s.toLowerCase().indexOf("<script")).toBe(2);
  });

  it("honours `from` and returns -1 when absent", () => {
    expect(indexOfIgnoreCase("<a><A>", "<a", 1)).toBe(3);
    expect(indexOfIgnoreCase("<a><A>", "<b")).toBe(-1);
    expect(indexOfIgnoreCase("", "<a")).toBe(-1);
    expect(indexOfIgnoreCase("<a", "<a", 1)).toBe(-1);
  });

  it("matches the Kelvin sign as k, exactly like the old toLowerCase search", () => {
    expect(indexOfIgnoreCase("x<linK", "<link")).toBe(1);
    expect(indexOfIgnoreCase("x<lİnk", "<link")).toBe(-1); // İ is not i
  });

  it("equals toLowerCase().indexOf on seeded strings without U+0130", () => {
    const alphabet = [
      "<",
      ">",
      "l",
      "L",
      "i",
      "I",
      "n",
      "N",
      "k",
      "K",
      "K",
      "ẞ",
      "ß",
      "ſ",
      "Σ",
      "σ",
      "\u{10400}",
      "a",
      "m",
      "e",
      "t",
      "T",
      "s",
      "S",
      "c",
      "r",
      "p",
      "P",
      " ",
      "\n",
      ".",
      "o",
    ];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let n = 0; n < 3000; n++) {
      let s = "";
      const len = Math.floor(rnd() * 40);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      for (const needle of ["<link", "<meta", "<script", "cb28utrk.com", "k"]) {
        const from = Math.floor(rnd() * 5);
        expect(indexOfIgnoreCase(s, needle, from)).toBe(s.toLowerCase().indexOf(needle, from));
      }
    }
  });
});

describe("tag detectors with length-changing characters before a tag (gc-8jd)", () => {
  const prefixes: Record<string, string> = {
    "U+0130 (İ)": "<p>İstanbul</p>",
    "many U+0130": "<p>" + "İ".repeat(500) + "</p>",
    "U+212A (Kelvin)": "<p>5 K</p>",
    "U+1E9E (capital sharp s)": "<p>STRAẞE</p>",
    mixed: "<p>İ K ẞ Σ ſ \u{10400}</p>",
  };

  for (const [label, prefix] of Object.entries(prefixes)) {
    it(`finds a <script> after ${label} with the right line and snippet`, () => {
      const content = `${prefix}\n<div>\n${KLAVIYO_SCRIPT}\n</div>`;
      const findings = detectGhostScripts({ filename: "layout/theme.liquid", content });
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Klaviyo");
      expect(findings[0].lineNumber).toBe(3);
      expect(findings[0].codeSnippet).toContain(KLAVIYO_SCRIPT);
    });

    it(`finds a <link> on the same line after ${label}`, () => {
      const content = `${prefix} ${KLAVIYO_STYLE}`;
      const findings = detectGhostStyles({ filename: "layout/theme.liquid", content });
      expect(findings).toHaveLength(1);
      expect(findings[0].lineNumber).toBe(1);
    });
  }

  it("finds every later tag on the line, not just the first, after an İ", () => {
    const content =
      'İ <meta name="description" content="a"> İİ <meta name="description" content="b">';
    const findings = detectDuplicateMetaTags({ filename: "layout/theme.liquid", content });
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("description");
  });
});

describe("malicious-domain snippet anchor with U+0130 on the line (gc-8jd)", () => {
  it("centres the snippet on the domain in the original line", () => {
    const tag = '<script src="https://shopify.jsdeliver.cloud/config.js"></script>';
    const line = "İ".repeat(60) + tag;
    const findings = detectMaliciousScripts({ filename: "layout/theme.liquid", content: line });
    expect(findings).toHaveLength(1);
    const at = line.indexOf("jsdeliver.cloud");
    expect(findings[0].codeSnippet).toBe(line.slice(at - 40, at - 40 + 300));
    expect(findings[0].codeSnippet).toContain("shopify.jsdeliver.cloud/config.js");
  });
});
