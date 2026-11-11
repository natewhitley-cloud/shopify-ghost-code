/**
 * gc-t44r X5a / X2 (r5), retargeted after the second parser was removed
 * (r6): scan-time outcomes of locating removal spans. A span the guard
 * refuses is never stored; a guard throw never fails the scan.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  mode: "real" as "real" | "refuse" | "throw",
  calls: 0,
}));

vi.mock("../../app/lib/removal-span", async (orig) => {
  const real = (await orig()) as typeof import("../../app/lib/removal-span");
  return {
    ...real,
    removalSpanFor: (...args: Parameters<typeof real.removalSpanFor>) => {
      holder.calls++;
      if (holder.mode === "throw") throw new Error("guard boom");
      if (holder.mode === "refuse") {
        return { ok: false as const, reason: "IN_NON_CODE_REGION" as const };
      }
      return real.removalSpanFor(...args);
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

describe("scan-time span outcomes", () => {
  it("control: both findings carry a span", () => {
    const found = fixable(CONTENT);
    expect(found.length).toBe(2);
    for (const f of found) expect(f.spanStart).toBeTypeOf("number");
  });

  it("the guard refuses: the finding is reported with no span", () => {
    holder.mode = "refuse";
    const found = fixable(CONTENT);
    expect(found.length).toBe(2);
    for (const f of found) {
      expect(f.spanStart).toBeUndefined();
      expect(f.spanEnd).toBeUndefined();
      expect(f.spanSha256).toBeUndefined();
    }
  });

  it("a guard throw: the scan completes and the findings have no span", () => {
    holder.mode = "throw";
    const found = fixable(CONTENT);
    expect(found.length).toBe(2);
    for (const f of found) expect(f.spanStart).toBeUndefined();
    // One attempt per detector (script, style), not per finding.
    expect(holder.calls).toBeLessThanOrEqual(2);
  });

  it("the r5 X1 document (adoption-agency blow-up for a tree builder) scans fast; the guard decides", () => {
    let blow = "<div>";
    for (let i = 0; i < 4900; i++) blow += `<b i=${i}>`;
    blow += "</div>" + "<div>x</div>".repeat(4900);
    const content = `${STYLE}\n${blow}`;
    const t = performance.now();
    const found = fixable(content);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(found.length).toBe(1);
    expect(content.slice(found[0].spanStart, found[0].spanEnd)).toBe(STYLE);
  });
});
