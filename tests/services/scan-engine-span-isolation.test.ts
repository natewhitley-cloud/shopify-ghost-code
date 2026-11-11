/**
 * Audit r6 (logic) M1, L4, L5, retargeted after the second parser was
 * removed (r6): a throw while locating a span (the guard, nonCodeRanges,
 * liquidBlockRanges) leaves that file's fixable findings without spans,
 * keeps its other findings and every other file's spans, completes the
 * scan, is not retried per finding, and never outlives its scan.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  guardThrowFor: null as string | null,
  rangesThrowFor: null as string | null,
  blocksThrowFor: null as string | null,
  guardCalls: new Map<string, number>(),
  rangesCalls: new Map<string, number>(),
}));

vi.mock("../../app/lib/removal-span", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/removal-span");
  return {
    ...real,
    removalSpanFor: (...args: Parameters<typeof real.removalSpanFor>) => {
      const key = args[1].includes("AAA") ? "A" : "B";
      holder.guardCalls.set(key, (holder.guardCalls.get(key) ?? 0) + 1);
      if (holder.guardThrowFor && args[1].includes(holder.guardThrowFor)) {
        throw new Error("guard boom");
      }
      return real.removalSpanFor(...args);
    },
    nonCodeRanges: (content: string) => {
      const key = content.includes("AAA") ? "A" : "B";
      holder.rangesCalls.set(key, (holder.rangesCalls.get(key) ?? 0) + 1);
      if (holder.rangesThrowFor && content.includes(holder.rangesThrowFor)) {
        throw new Error("ranges boom");
      }
      return real.nonCodeRanges(content);
    },
    liquidBlockRanges: (content: string) => {
      if (holder.blocksThrowFor && content.includes(holder.blocksThrowFor)) {
        throw new Error("blocks boom");
      }
      return real.liquidBlockRanges(content);
    },
  };
});

import { scanThemeFiles } from "../../app/services/scan-engine.server";

const SCRIPT = `<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>`;
const SCRIPT2 = `<script async src="https://static.klaviyo.com/onsite/js/other.js?company_id=X"></script>`;
const STYLE = `<link rel="stylesheet" href="https://static.klaviyo.com/onsite/css/a.css">`;
const RENDER = `{%- render 'judgeme_widgets', product: product -%}`;
const DUP_META = `<meta name="description" content="x"><meta name="description" content="y">`;
const A = `<html><head>\n${STYLE}\n${SCRIPT}\n${SCRIPT2}\n${DUP_META}\n</head><body><p>AAA</p>\n${RENDER}\n</body></html>`;
const B = `<html><head><meta charset=utf-8>\n\n${SCRIPT}\n${STYLE}\n</head><body><p>BBB</p>\n${RENDER}\n</body></html>`;
const FIXABLE = ["GHOST_SCRIPT", "GHOST_STYLE", "GHOST_PRECONNECT", "GHOST_SNIPPET"];

const FILES = [
  { filename: "layout/theme.liquid", content: A },
  { filename: "sections/b.liquid", content: B },
];
const fixableIn = (findings: ReturnType<typeof scanThemeFiles>["findings"], filename: string) =>
  findings.filter((f) => f.filename === filename && FIXABLE.includes(f.findingType));

afterEach(() => {
  holder.guardThrowFor = null;
  holder.rangesThrowFor = null;
  holder.blocksThrowFor = null;
  holder.guardCalls.clear();
  holder.rangesCalls.clear();
});

describe("scan-time span isolation (audit r6)", () => {
  it("two files in one scan: each file's spans come from its own content", () => {
    const { findings } = scanThemeFiles(FILES);
    const a = fixableIn(findings, "layout/theme.liquid");
    const b = fixableIn(findings, "sections/b.liquid");
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(b.length).toBeGreaterThanOrEqual(3);
    for (const f of [...a, ...b]) {
      const content = f.filename === "layout/theme.liquid" ? A : B;
      expect(typeof f.spanStart).toBe("number");
      const text = content.slice(f.spanStart!, f.spanEnd!);
      expect([SCRIPT, SCRIPT2, STYLE, RENDER]).toContain(text);
    }
  });

  it.each([
    ["a guard throw", "guardThrowFor"],
    ["a nonCodeRanges throw", "rangesThrowFor"],
    ["a liquidBlockRanges throw", "blocksThrowFor"],
  ] as const)(
    "%s in file A: A's affected findings have no span, B keeps its spans, A's other findings are kept, the scan completes",
    (_label, key) => {
      holder[key] = "AAA";
      const { findings } = scanThemeFiles(FILES);
      const a = fixableIn(findings, "layout/theme.liquid");
      expect(a.length).toBeGreaterThan(0);
      // liquidBlockRanges only runs for render findings: only those lose spans.
      const affected =
        key === "blocksThrowFor" ? a.filter((f) => f.findingType === "GHOST_SNIPPET") : a;
      expect(affected.length).toBeGreaterThan(0);
      expect(affected.every((f) => f.spanStart === undefined)).toBe(true);
      // A liquidBlockRanges throw must not cost A's script/style spans (audit r7 S5).
      if (key === "blocksThrowFor") {
        const unaffected = a.filter((f) => f.findingType !== "GHOST_SNIPPET");
        expect(unaffected.length).toBeGreaterThan(0);
        expect(unaffected.every((f) => typeof f.spanStart === "number")).toBe(true);
      }
      expect(
        fixableIn(findings, "sections/b.liquid").every((f) => typeof f.spanStart === "number"),
      ).toBe(true);
      expect(
        findings.some(
          (f) => f.filename === "layout/theme.liquid" && !FIXABLE.includes(f.findingType),
        ),
      ).toBe(true);
    },
  );

  it("after a guard throw a detector does not retry the file for its next finding", () => {
    holder.guardThrowFor = "AAA";
    const { findings } = scanThemeFiles([FILES[0]]);
    const scripts = fixableIn(findings, "layout/theme.liquid").filter(
      (f) => f.findingType === "GHOST_SCRIPT",
    );
    expect(scripts.length).toBe(2);
    // One attempt per detector (script, style, snippet), not one per finding.
    expect(holder.guardCalls.get("A")).toBeLessThanOrEqual(3);
  });

  it("a failure does not outlive its scan (same content, next scan)", () => {
    holder.guardThrowFor = "AAA";
    scanThemeFiles([FILES[0]]);
    holder.guardThrowFor = null;
    const again = fixableIn(scanThemeFiles([FILES[0]]).findings, "layout/theme.liquid");
    expect(again.length).toBeGreaterThanOrEqual(3);
    expect(again.every((f) => typeof f.spanStart === "number")).toBe(true);
  });
});

describe("gc-mlnk 3: one span parse per file per scan", () => {
  it("nonCodeRanges runs once per file across the fixable detectors", () => {
    const { findings } = scanThemeFiles(FILES);
    // A has script, style and snippet findings: three detectors, one parse.
    const types = new Set(fixableIn(findings, "layout/theme.liquid").map((f) => f.findingType));
    expect(types.size).toBeGreaterThanOrEqual(3);
    expect(holder.rangesCalls.get("A")).toBe(1);
    expect(holder.rangesCalls.get("B")).toBe(1);
  });

  it("a nonCodeRanges throw is not retried by the next detector of that file", () => {
    holder.rangesThrowFor = "AAA";
    scanThemeFiles([FILES[0]]);
    expect(holder.rangesCalls.get("A")).toBe(1);
  });

  it("the shared parse is per scan: a second scan parses again", () => {
    scanThemeFiles([FILES[0]]);
    scanThemeFiles([FILES[0]]);
    expect(holder.rangesCalls.get("A")).toBe(2);
  });
});
