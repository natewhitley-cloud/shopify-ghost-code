import { describe, expect, it } from "vitest";

import {
  detectSuspiciousCode,
  hasFilenameMarker,
  isSuspiciousCodeCandidate,
  summarizeSuspiciousCode,
  SUSPICIOUS_CODE_FILES_CAP,
} from "../../app/lib/suspicious-code";
import {
  CHARCODE_ATOB_SAMPLE,
  CHARCODE_EVAL_SAMPLE,
  DAWN_GLOBAL_STYLE,
  EVAL_WITHOUT_NUMERIC_CHARCODE,
  HEX_ESCAPE_SAMPLE,
  JQUERY_STYLE,
  LODASH_STYLE,
  OBFUSCATOR_SAMPLE,
  PACKER_SAMPLE,
  SWIPER_STYLE,
} from "../fixtures/suspicious-code-samples";

describe("detectSuspiciousCode: positives", () => {
  it("flags a Dean Edwards packer payload", () => {
    expect(detectSuspiciousCode("assets/a.js", PACKER_SAMPLE)).toEqual({
      suspicious: true,
      reasons: ["packer"],
    });
  });

  it("flags javascript-obfuscator _0x identifiers", () => {
    const r = detectSuspiciousCode("assets/a.js", OBFUSCATOR_SAMPLE);
    expect(r.suspicious).toBe(true);
    expect(r.reasons).toContain("obfuscator_identifiers");
  });

  it("flags a dense run of hex escapes", () => {
    expect(detectSuspiciousCode("assets/a.js", HEX_ESCAPE_SAMPLE).reasons).toEqual([
      "hex_escape_density",
    ]);
  });

  it("flags fromCharCode with numeric args alongside eval", () => {
    expect(detectSuspiciousCode("assets/a.js", CHARCODE_EVAL_SAMPLE).reasons).toEqual([
      "charcode_eval",
    ]);
  });

  it("flags hex-numeric fromCharCode alongside atob", () => {
    expect(detectSuspiciousCode("assets/a.js", CHARCODE_ATOB_SAMPLE).reasons).toEqual([
      "charcode_eval",
    ]);
  });

  it("flags a *.null.js filename even when the content is clean", () => {
    expect(detectSuspiciousCode("assets/shrine.null.js", DAWN_GLOBAL_STYLE)).toEqual({
      suspicious: true,
      reasons: ["filename_marker"],
    });
  });

  it("reports the filename marker first and every other reason that applies", () => {
    expect(detectSuspiciousCode("assets/theme.null.min.js", PACKER_SAMPLE).reasons).toEqual([
      "filename_marker",
      "packer",
    ]);
  });

  it("flags a packer variant with whitespace and the (p,a,c,k,e) form", () => {
    const packed = "eval( function ( p , a , c , k , e ) { return p }('x',1,1,'a'.split('|')))";
    expect(detectSuspiciousCode("assets/a.js", packed).reasons).toEqual(["packer"]);
  });
});

describe("detectSuspiciousCode: negatives", () => {
  it.each([
    ["jQuery-style", JQUERY_STYLE],
    ["Swiper/Flickity-style", SWIPER_STYLE],
    ["lodash-style", LODASH_STYLE],
    ["Dawn global.js-style", DAWN_GLOBAL_STYLE],
    ["eval with non-numeric fromCharCode", EVAL_WITHOUT_NUMERIC_CHARCODE],
  ])("does not flag a %s file", (_label, content) => {
    expect(detectSuspiciousCode("assets/global.js", content)).toEqual({
      suspicious: false,
      reasons: [],
    });
  });

  it("does not flag empty content", () => {
    expect(detectSuspiciousCode("assets/empty.js", "")).toEqual({
      suspicious: false,
      reasons: [],
    });
  });

  it("does not flag 19 _0x identifiers (threshold is 20)", () => {
    const ids = Array.from({ length: 19 }, (_, i) => `_0x${(0xa000 + i).toString(16)}`).join(";");
    expect(detectSuspiciousCode("assets/a.js", ids).suspicious).toBe(false);
    const twenty = ids + ";_0xbeef";
    expect(detectSuspiciousCode("assets/a.js", twenty).reasons).toEqual(["obfuscator_identifiers"]);
  });

  it("does not count _0x followed by more than 6 hex digits", () => {
    const ids = Array.from({ length: 25 }, () => "_0x1234567").join(";");
    expect(detectSuspiciousCode("assets/a.js", ids).suspicious).toBe(false);
  });

  it("does not flag a tiny file with a few hex escapes (minimum count)", () => {
    // 3 escapes in ~40 chars is a high density but far below the minimum count.
    expect(detectSuspiciousCode("assets/a.js", 'var s="a\\x20b\\x20c\\x20";').suspicious).toBe(
      false,
    );
  });

  it("does not flag hex escapes spread thinly through a large file", () => {
    const content = 'var s="\\x20";'.repeat(30) + "x".repeat(20_000);
    expect(detectSuspiciousCode("assets/a.js", content).suspicious).toBe(false);
  });

  it("does not flag numeric fromCharCode without eval or atob", () => {
    expect(
      detectSuspiciousCode("assets/a.js", "var bom=String.fromCharCode(65279,65,66);").suspicious,
    ).toBe(false);
  });

  it("does not flag 'evaluate(' or 'myatob(' as eval / atob calls", () => {
    const content = "String.fromCharCode(1,2,3);evaluate(x);myatob(y);";
    expect(detectSuspiciousCode("assets/a.js", content).suspicious).toBe(false);
  });
});

describe("hasFilenameMarker", () => {
  it.each([
    "assets/shrine.null.js",
    "assets/theme.null.min.js",
    "assets/SHRINE.NULL.JS",
    "assets/theme-nulled.js",
    "assets/nulled_theme.js",
    "assets/app.crack.js",
    "assets/cracked-bundle.js",
    "assets/warez_loader.js",
  ])("flags %s", (path) => {
    expect(hasFilenameMarker(path)).toBe(true);
  });

  // Decision: "null" counts only as a dot-delimited token, the pirated-build
  // form; whole words that merely contain a marker never count.
  it.each([
    "assets/nullable-helper.js",
    "assets/annulled.js",
    "assets/null-safe.js",
    "assets/is_null.js",
    "assets/crackle-effect.js",
    "assets/global.js",
  ])("does not flag %s", (path) => {
    expect(hasFilenameMarker(path)).toBe(false);
  });

  it("only reads the file name, not directory segments", () => {
    expect(hasFilenameMarker("null.dir/theme.js")).toBe(false);
  });
});

describe("isSuspiciousCodeCandidate", () => {
  it.each(["assets/a.js", "assets/a.mjs", "assets/theme.js.liquid"])("includes %s", (p) => {
    expect(isSuspiciousCodeCandidate(p)).toBe(true);
  });
  it.each([
    "assets/theme.css",
    "assets/theme.css.liquid",
    "snippets/a.liquid",
    "templates/index.json",
    "layout/theme.js",
  ])("excludes %s", (p) => {
    expect(isSuspiciousCodeCandidate(p)).toBe(false);
  });
});

describe("summarizeSuspiciousCode", () => {
  it("returns an empty summary for no hits", () => {
    expect(summarizeSuspiciousCode([])).toEqual({ fileCount: 0, files: [], reasonCounts: {} });
  });

  it("counts reasons per file and sorts files by path", () => {
    expect(
      summarizeSuspiciousCode([
        { path: "assets/z.js", reasons: ["packer"] },
        { path: "assets/a.null.js", reasons: ["filename_marker", "packer"] },
      ]),
    ).toEqual({
      fileCount: 2,
      files: [
        { path: "assets/a.null.js", reasons: ["filename_marker", "packer"] },
        { path: "assets/z.js", reasons: ["packer"] },
      ],
      reasonCounts: { filename_marker: 1, packer: 2 },
    });
  });

  it("caps the file list at 20 but keeps the full count and reason totals", () => {
    const hits = Array.from({ length: 25 }, (_, i) => ({
      path: `assets/f${String(i).padStart(2, "0")}.js`,
      reasons: ["hex_escape_density" as const],
    }));
    const s = summarizeSuspiciousCode(hits);
    expect(s.fileCount).toBe(25);
    expect(s.files).toHaveLength(SUSPICIOUS_CODE_FILES_CAP);
    expect(s.files[0].path).toBe("assets/f00.js");
    expect(s.files[19].path).toBe("assets/f19.js");
    expect(s.reasonCounts).toEqual({ hex_escape_density: 25 });
  });
});

describe("detectSuspiciousCode: linear time", () => {
  // Pathological inputs for each regex: long runs of near-matches that a
  // backtracking pattern would re-scan from every start position.
  it.each([
    ["near-miss packer prefixes", "eval ( function ( p , a , c , k ,".repeat(160_000)],
    ["near-miss fromCharCode args", "fromCharCode(1 ,2 ,".repeat(260_000)],
    ["_0x prefixes without enough hex", "_0x12;".repeat(840_000)],
    ["unterminated hex escapes", "\\x4".repeat(1_700_000)],
    ["whitespace runs", " ".repeat(5_000_000)],
  ])("scans 5 MB of %s within the time bound", (_label, content) => {
    expect(content.length).toBeGreaterThanOrEqual(4_900_000);
    const start = performance.now();
    detectSuspiciousCode("assets/big.js", content);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
