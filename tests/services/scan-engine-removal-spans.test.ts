import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { scanThemeFiles } from "../../app/services/scan-engine.server";

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const SCRIPT = `<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>`;
const PRECONNECT = `<link rel="preconnect" href="https://static.klaviyo.com">`;
const STYLE = `<link rel="stylesheet" href="https://static.klaviyo.com/onsite/css/a.css">`;
const RENDER = `{%- render 'judgeme_widgets', product: product -%}`;

describe("scanThemeFiles persists removal spans (gc-tib slice 3)", () => {
  const content = [
    "<html><head>",
    `  ${PRECONNECT}`,
    `  ${STYLE}`,
    `  ${SCRIPT}`,
    "</head><body>",
    `  ${RENDER}`,
    "  {% liquid",
    "    render 'judgeme_widgets'",
    "  %}",
    "  {% comment %}",
    `  ${SCRIPT}`,
    "  {% endcomment %}",
    `  <script src="https://static.klaviyo.com/onsite/js/b.js">inline()</script>`,
    "</body></html>",
  ].join("\n");
  const { findings } = scanThemeFiles([{ filename: "layout/theme.liquid", content }]);
  const fixable = findings.filter((f) =>
    ["GHOST_SCRIPT", "GHOST_STYLE", "GHOST_PRECONNECT", "GHOST_SNIPPET"].includes(f.findingType),
  );

  it("each span covers exactly its element and its hash matches that text", () => {
    const withSpan = fixable.filter((f) => f.spanStart !== undefined);
    const texts = withSpan.map((f) => content.slice(f.spanStart, f.spanEnd));
    expect(texts).toEqual(
      expect.arrayContaining([PRECONNECT, STYLE, SCRIPT, RENDER, "    render 'judgeme_widgets'"]),
    );
    for (const f of withSpan) {
      expect(f.spanSha256).toBe(sha(content.slice(f.spanStart, f.spanEnd)));
      // The span starts on the finding's own line.
      expect(content.slice(0, f.spanStart).split("\n").length).toBe(f.lineNumber);
    }
  });

  it("findings whose element is uncertain carry no span (and are still reported)", () => {
    const inline = fixable.find((f) => f.lineNumber === 13);
    expect(inline?.findingType).toBe("GHOST_SCRIPT");
    expect(inline?.spanStart).toBeUndefined();
    expect(inline?.spanSha256).toBeUndefined();
    // The commented-out script (line 11), if reported at all, has no span.
    const commented = fixable.find((f) => f.lineNumber === 11);
    if (commented) expect(commented.spanStart).toBeUndefined();
  });

  it("non-fixable finding types never carry a span", () => {
    for (const f of findings.filter((x) => !fixable.includes(x))) {
      expect(f.spanStart).toBeUndefined();
    }
  });
});
