/** gc-f7ox: a cut must not join the text around it into a character reference. */
import { describe, expect, it } from "vitest";

import { spliceSpans } from "../../app/lib/theme-splice";

const LINK = "<link rel=stylesheet href=a>";

function cut(before: string, after: string, el = LINK) {
  const content = before + el + after;
  return spliceSpans(content, [{ start: before.length, end: before.length + el.length }]);
}

describe("JOINS_TEXT", () => {
  it.each([
    ["<p>&l", "t;script&gt;</p>"],
    ["<p>&", "lt;</p>"],
    ["<p>&", "#60;</p>"],
    ["<p>&#", "60;</p>"],
    ["<p>&#x3", "c;</p>"],
    ["<p>&amp", ";</p>"],
    ["<p>&#" + "0".repeat(200), "60;</p>"],
  ])("refuses %j + element + %j", (before, after) => {
    const res = cut(before, after);
    expect(res.removed).toEqual([]);
    expect(res.refused).toEqual([{ span: expect.any(Object), reason: "JOINS_TEXT" }]);
    expect(res.content).toBe(before + LINK + after);
  });

  it.each([
    ["<p>a&b ", "t;</p>"],
    ["<p>&lt; ", "x</p>"],
    ["<p>&l\n", "t;</p>"],
    ["<p>&", " x</p>"],
    ["<p>x", "y</p>"],
    ["<p>&", "</p>"],
    ["&", ""],
    ["<p>&lt", "</p>"],
  ])("allows %j + element + %j", (before, after) => {
    const res = cut(before, after);
    expect(res.refused).toEqual([]);
    expect(res.content).toBe(before + after);
  });

  it("touching spans are one cut: judged on the outer sides, refused together", () => {
    const content = `<p>&l${LINK}${LINK}t;</p>`;
    const a = { start: 5, end: 5 + LINK.length };
    const b = { start: a.end, end: a.end + LINK.length };
    const res = spliceSpans(content, [a, b]);
    expect(res.removed).toEqual([]);
    expect(res.refused.map((r) => r.reason)).toEqual(["JOINS_TEXT", "JOINS_TEXT"]);
  });

  it("a refused span doesn't stop another span in the same file", () => {
    const content = `<p>&l${LINK}t;</p>\n${LINK}\n<p>ok</p>`;
    const a = { start: 5, end: 5 + LINK.length };
    const bStart = content.indexOf(LINK, a.end);
    const res = spliceSpans(content, [a, { start: bStart, end: bStart + LINK.length }]);
    expect(res.removed).toHaveLength(1);
    expect(res.refused.map((r) => r.reason)).toEqual(["JOINS_TEXT"]);
    expect(res.content).toBe(`<p>&l${LINK}t;</p>\n<p>ok</p>`);
  });

  it("a long run of name chars is linear (no window, no quadratic scan)", () => {
    const run = "a".repeat(500_000);
    const t = performance.now();
    const res = cut(`<p>&${run}`, "b;</p>");
    expect(res.refused.map((r) => r.reason)).toEqual(["JOINS_TEXT"]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
