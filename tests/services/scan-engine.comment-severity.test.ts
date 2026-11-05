/**
 * gc-15d9: leftover app code inside a Liquid {% comment %} or {% doc %} block
 * never renders, so GHOST_SCRIPT / GHOST_STYLE findings there are LOW (the
 * existing convention). Decided by the finding's LINE (the engine's doc-aware
 * comment line set), not by whether the 3-line snippet contains an opener:
 * the snippet test both missed openers 2+ lines above (false HIGH) and
 * downgraded LIVE code next to a one-line block (false LOW, audit F1).
 */
import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { scanThemeFiles, type ThemeFile } from "../../app/services/scan-engine.server";

const SCRIPT = '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>';
const STYLE = '<link rel="stylesheet" href="https://cdn.loox.io/widget/loox.css">';
const MALICIOUS = '<script src="https://www.cb28utrk.com/scripts/shopify/click.js"></script>';

function file(content: string): ThemeFile {
  return { filename: "layout/theme.liquid", content } as ThemeFile;
}

function severitiesOf(content: string, type: FindingType): Severity[] {
  return scanThemeFiles([file(content)])
    .findings.filter((f) => f.findingType === type)
    .map((f) => f.severity);
}

const CASES = [
  { type: FindingType.GHOST_SCRIPT, tag: SCRIPT },
  { type: FindingType.GHOST_STYLE, tag: STYLE },
] as const;

const BLOCKS = [
  { name: "comment", open: "{% comment %}", close: "{% endcomment %}" },
  { name: "comment, whitespace-stripping", open: "{%- comment -%}", close: "{%- endcomment -%}" },
  { name: "doc", open: "{% doc %}", close: "{% enddoc %}" },
  { name: "doc, whitespace-stripping", open: "{%- doc -%}", close: "{%- enddoc -%}" },
] as const;

describe.each(CASES)("$type severity by line position (gc-15d9)", ({ type, tag }) => {
  it("sanity: live, with no Liquid block anywhere, is not LOW", () => {
    const sev = severitiesOf(`<head>\n${tag}\n</head>`, type);
    expect(sev).toHaveLength(1);
    expect(sev[0]).not.toBe(Severity.LOW);
  });

  describe.each(BLOCKS)("$name block", ({ open, close }) => {
    it("inside the block, opener 2+ lines above (outside the snippet): LOW", () => {
      const content = [open, "  @example", "  usage notes", `  ${tag}`, close, "<div></div>"].join(
        "\n",
      );
      expect(severitiesOf(content, type)).toEqual([Severity.LOW]);
    });

    it("inside the block, opener on the line above: LOW", () => {
      expect(severitiesOf([open, `  ${tag}`, close].join("\n"), type)).toEqual([Severity.LOW]);
    });

    it("live code on the line AFTER a one-line block keeps its severity", () => {
      const live = severitiesOf(`<head>\n${tag}\n</head>`, type);
      const content = ["<head>", `${open} Renders reviews. ${close}`, tag, "</head>"].join("\n");
      expect(severitiesOf(content, type)).toEqual(live);
    });

    it("live code on the line BEFORE a one-line block keeps its severity", () => {
      const live = severitiesOf(`<head>\n${tag}\n</head>`, type);
      const content = ["<head>", tag, `${open} Renders reviews. ${close}`, "</head>"].join("\n");
      expect(severitiesOf(content, type)).toEqual(live);
    });

    it("live code right after a multi-line block closes keeps its severity", () => {
      const live = severitiesOf(`<head>\n${tag}\n</head>`, type);
      const content = [open, "  notes", close, tag, "</head>"].join("\n");
      expect(severitiesOf(content, type)).toEqual(live);
    });
  });
});

describe("security findings are never downgraded by the comment rule (gc-15d9)", () => {
  it("MALICIOUS_SCRIPT inside a {% doc %} block stays HIGH", () => {
    const content = ["{% doc %}", "  @example", `  ${MALICIOUS}`, "{% enddoc %}"].join("\n");
    const sev = scanThemeFiles([file(content)])
      .findings.filter((f) => f.findingType === FindingType.MALICIOUS_SCRIPT)
      .map((f) => f.severity);
    expect(sev.every((s) => s === Severity.HIGH)).toBe(true);
  });
});
