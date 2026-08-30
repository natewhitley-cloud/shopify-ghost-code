import { describe, expect, it } from "vitest";

import { buildSnippet, lineNumberAtOffset } from "../../app/services/scan-engine.server";

// Regression guard for the per-file line-index cache (gc-06e.8). lineNumberAtOffset
// (binary search) and buildSnippet (cached split) replaced O(offset)/O(N) implementations;
// these tests pin them to the ORIGINAL algorithms so a future cache refactor can't
// silently change any finding's lineNumber or codeSnippet.

/** Original O(offset) newline-count implementation. */
function refLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/** Original re-split implementation. */
function refSnippet(content: string, lineNumber: number): string {
  const allLines = content.split("\n");
  const start = Math.max(0, lineNumber - 2);
  const end = Math.min(allLines.length, lineNumber + 1);
  return allLines.slice(start, end).join("\n").slice(0, 300);
}

const CONTENTS: Record<string, string> = {
  empty: "",
  noNewline: "the quick brown fox",
  simple: "a\nb\nc",
  trailingNewline: "a\nb\nc\n",
  onlyNewlines: "\n\n\n",
  blankLines: "line one is a bit longer\nsecond\n\nfourth after a blank\nx",
  crlf: "a\r\nb\r\nc\r\n",
  // A few hundred varied lines to exercise the binary search at depth.
  large: Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`).join("\n"),
};

describe("lineNumberAtOffset (cached binary search) matches the original loop", () => {
  for (const [name, content] of Object.entries(CONTENTS)) {
    it(`equivalence across all offsets — ${name}`, () => {
      // Include out-of-range offsets (negative, past EOF) as edge cases.
      for (let offset = -2; offset <= content.length + 3; offset++) {
        expect(lineNumberAtOffset(content, offset)).toBe(refLine(content, offset));
      }
    });
  }

  it("handles specific edge offsets", () => {
    const c = "a\nb\nc";
    expect(lineNumberAtOffset(c, 0)).toBe(1); // start
    expect(lineNumberAtOffset(c, 1)).toBe(1); // before first \n
    expect(lineNumberAtOffset(c, 2)).toBe(2); // just past first \n
    expect(lineNumberAtOffset(c, 100)).toBe(3); // past EOF clamps to last line
  });
});

describe("buildSnippet (cached split) matches the original re-split", () => {
  for (const [name, content] of Object.entries(CONTENTS)) {
    it(`equivalence across line numbers — ${name}`, () => {
      const lineCount = content.split("\n").length;
      for (let ln = -2; ln <= lineCount + 3; ln++) {
        expect(buildSnippet(content, ln)).toBe(refSnippet(content, ln));
      }
    });
  }
});

describe("single-entry cache stays correct across content switches", () => {
  it("returns correct results when content alternates (cache rebuilds)", () => {
    const a = "a\nb\nc\nd";
    const b = "x\ny";
    // Interleave so the single-entry cache is repeatedly invalidated.
    expect(lineNumberAtOffset(a, 6)).toBe(refLine(a, 6));
    expect(lineNumberAtOffset(b, 3)).toBe(refLine(b, 3));
    expect(lineNumberAtOffset(a, 2)).toBe(refLine(a, 2));
    expect(buildSnippet(b, 2)).toBe(refSnippet(b, 2));
    expect(buildSnippet(a, 4)).toBe(refSnippet(a, 4));
  });

  it("two byte-identical contents both resolve correctly (value-equality cache hit)", () => {
    const original = "one\ntwo\nthree";
    const rebuilt = ["one", "two", "three"].join("\n"); // equal by value, distinct construction
    expect(lineNumberAtOffset(original, 8)).toBe(refLine(original, 8));
    expect(lineNumberAtOffset(rebuilt, 8)).toBe(refLine(rebuilt, 8));
    expect(buildSnippet(rebuilt, 2)).toBe(refSnippet(rebuilt, 2));
  });
});
