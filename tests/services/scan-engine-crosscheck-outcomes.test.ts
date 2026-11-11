/**
 * gc-t44r X5a / X2 (r5): scan-time outcomes of the parse5 cross-check. A span
 * the guard accepts but parse5 refuses is never stored; a cross-check throw
 * (or a document past the parse5 node budget) never fails the scan.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  mode: "real" as "real" | "refuse" | "throw",
  calls: 0,
}));

vi.mock("../../app/lib/span-crosscheck.server", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/span-crosscheck.server");
  return {
    ...real,
    createSpanCrossCheck: (content: string) => {
      const inner = real.createSpanCrossCheck(content);
      return (type: string, span: { start: number; end: number }) => {
        holder.calls++;
        if (holder.mode === "throw") throw new Error("parse5 boom");
        if (holder.mode === "refuse")
          return { ok: false as const, reason: "PARSER_DISAGREES" as const };
        return inner(type, span);
      };
    },
  };
});

import { scanThemeFiles } from "../../app/services/scan-engine.server";

const SCRIPT = `<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>`;
const STYLE = `<link rel="stylesheet" href="https://static.klaviyo.com/onsite/css/a.css">`;
const CONTENT = `<html><head>\n${STYLE}\n${SCRIPT}\n</head><body><p>x</p></body></html>`;

const FIXABLE = ["GHOST_SCRIPT", "GHOST_STYLE", "GHOST_PRECONNECT", "GHOST_SNIPPET"];
const fixable = (content: string) =>
  scanThemeFiles([{ filename: "layout/theme.liquid", content }]).findings.filter((f) =>
    FIXABLE.includes(f.findingType),
  );

afterEach(() => {
  holder.mode = "real";
  holder.calls = 0;
});

describe("scan-time cross-check outcomes", () => {
  it("control: with parse5 agreeing, both findings carry a span", () => {
    const found = fixable(CONTENT);
    expect(found.length).toBe(2);
    for (const f of found) expect(f.spanStart).toBeTypeOf("number");
  });

  it("guard accepts, parse5 refuses: the finding is reported with no span", () => {
    holder.mode = "refuse";
    const found = fixable(CONTENT);
    expect(found.length).toBe(2);
    for (const f of found) {
      expect(f.spanStart).toBeUndefined();
      expect(f.spanEnd).toBeUndefined();
      expect(f.spanSha256).toBeUndefined();
    }
  });

  it("a cross-check throw: the scan completes, findings have no span, and the file is checked once", () => {
    holder.mode = "throw";
    const found = fixable(CONTENT);
    expect(found.length).toBe(2);
    for (const f of found) expect(f.spanStart).toBeUndefined();
    expect(holder.calls).toBe(1);
  });

  it("the X1 document (parse5 past its node budget) scans in bounded time with no span", () => {
    let blow = "<div>";
    for (let i = 0; i < 4900; i++) blow += `<b i=${i}>`;
    blow += "</div>" + "<div>x</div>".repeat(4900);
    const content = `${STYLE}\n${blow}`;
    const t = performance.now();
    const found = fixable(content);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(found.length).toBe(1);
    expect(found[0].spanStart).toBeUndefined();
  });
});
