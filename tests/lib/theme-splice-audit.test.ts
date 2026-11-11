/**
 * gc-tib batch audit regressions for the splice engine (sec 10).
 */
import { describe, expect, it } from "vitest";

import { spliceSpans } from "../../app/lib/theme-splice";

const TAG = '<script src="https://cdn.app.io/a.js"></script>';

describe("spliceSpans: span at offset 0 (audit sec 10)", () => {
  it("drops the line a span at the very start of the file leaves empty", () => {
    expect(spliceSpans(`${TAG}\nB`, [{ start: 0, end: TAG.length }]).content).toBe("B");
  });

  it("keeps a pre-existing blank first line when the cut is on line 2", () => {
    const c = `\n${TAG}\nB`;
    expect(spliceSpans(c, [{ start: 1, end: 1 + TAG.length }]).content).toBe("\nB");
  });

  it("a whole-file span leaves an empty file", () => {
    expect(spliceSpans(TAG, [{ start: 0, end: TAG.length }]).content).toBe("");
  });
});
