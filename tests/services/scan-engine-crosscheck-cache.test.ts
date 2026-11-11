/**
 * Audit r6 (logic) M1, L4, L5: the per-file cross-check cache in the scan
 * engine is keyed by content, a throw in one file never touches another file
 * or the file's non-fixable findings, a guard throw is caught like a parse5
 * throw, and nothing cached outlives its scan.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  crossThrowFor: null as string | null,
  guardThrowFor: null as string | null,
}));

vi.mock("../../app/lib/span-crosscheck.server", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/span-crosscheck.server");
  return {
    ...real,
    createSpanCrossCheck: (content: string) => {
      const inner = real.createSpanCrossCheck(content);
      return (type: string, span: { start: number; end: number }) => {
        if (holder.crossThrowFor && content.includes(holder.crossThrowFor)) {
          throw new Error("cross-check boom");
        }
        return inner(type, span);
      };
    },
  };
});

vi.mock("../../app/lib/removal-span", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/removal-span");
  return {
    ...real,
    removalSpanFor: (...args: Parameters<typeof real.removalSpanFor>) => {
      if (holder.guardThrowFor && args[1].includes(holder.guardThrowFor)) {
        throw new Error("guard boom");
      }
      return real.removalSpanFor(...args);
    },
  };
});

import { scanThemeFiles } from "../../app/services/scan-engine.server";

const SCRIPT = `<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>`;
const STYLE = `<link rel="stylesheet" href="https://static.klaviyo.com/onsite/css/a.css">`;
const DUP_META = `<meta name="description" content="x"><meta name="description" content="y">`;
const A = `<html><head>\n${STYLE}\n${SCRIPT}\n${DUP_META}\n</head><body><p>AAA</p></body></html>`;
const B = `<html><head><meta charset=utf-8>\n\n${SCRIPT}\n${STYLE}\n</head><body><p>BBB</p></body></html>`;
const FIXABLE = ["GHOST_SCRIPT", "GHOST_STYLE", "GHOST_PRECONNECT", "GHOST_SNIPPET"];

const FILES = [
  { filename: "layout/theme.liquid", content: A },
  { filename: "sections/b.liquid", content: B },
];
const fixableIn = (findings: ReturnType<typeof scanThemeFiles>["findings"], filename: string) =>
  findings.filter((f) => f.filename === filename && FIXABLE.includes(f.findingType));

afterEach(() => {
  holder.crossThrowFor = null;
  holder.guardThrowFor = null;
});

describe("scan-time cross-check cache (audit r6)", () => {
  it("two files in one scan: each file's spans are checked against its own parse", () => {
    const { findings } = scanThemeFiles(FILES);
    const a = fixableIn(findings, "layout/theme.liquid");
    const b = fixableIn(findings, "sections/b.liquid");
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    for (const f of [...a, ...b]) {
      const content = f.filename === "layout/theme.liquid" ? A : B;
      expect(typeof f.spanStart).toBe("number");
      const text = content.slice(f.spanStart!, f.spanEnd!);
      expect(text === SCRIPT || text === STYLE).toBe(true);
    }
  });

  it.each([
    ["a cross-check throw", "crossThrowFor"],
    ["a guard throw", "guardThrowFor"],
  ] as const)(
    "%s in file A: A has no spans, B keeps its spans, A's other findings are kept, the scan completes",
    (_label, key) => {
      holder[key] = "AAA";
      const { findings } = scanThemeFiles(FILES);
      expect(fixableIn(findings, "layout/theme.liquid").length).toBeGreaterThan(0);
      expect(
        fixableIn(findings, "layout/theme.liquid").every((f) => f.spanStart === undefined),
      ).toBe(true);
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

  it("a refusal after a throw does not outlive its scan (same content, next scan)", () => {
    holder.crossThrowFor = "AAA";
    scanThemeFiles([FILES[0]]);
    holder.crossThrowFor = null;
    const again = fixableIn(scanThemeFiles([FILES[0]]).findings, "layout/theme.liquid");
    expect(again).toHaveLength(2);
    expect(again.every((f) => typeof f.spanStart === "number")).toBe(true);
  });
});
