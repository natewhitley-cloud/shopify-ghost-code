import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { classifySeverity } from "../../app/services/severity-classifier.server";

describe("classifySeverity", () => {
  // -------------------------------------------------------------------------
  // Default mappings
  // -------------------------------------------------------------------------

  it("returns HIGH for GHOST_SCRIPT by default", () => {
    expect(
      classifySeverity(FindingType.GHOST_SCRIPT, '<script src="//cdn.klaviyo.com/js/klaviyo.js">'),
    ).toBe(Severity.HIGH);
  });

  it("returns MEDIUM for GHOST_STYLE by default", () => {
    expect(
      classifySeverity(
        FindingType.GHOST_STYLE,
        '<link rel="stylesheet" href="//cdn.klaviyo.com/style.css">',
      ),
    ).toBe(Severity.MEDIUM);
  });

  it("returns MEDIUM for GHOST_SNIPPET by default", () => {
    expect(classifySeverity(FindingType.GHOST_SNIPPET, "{% render 'klaviyo-onsite' %}")).toBe(
      Severity.MEDIUM,
    );
  });

  it("returns LOW for GHOST_SECTION by default", () => {
    expect(classifySeverity(FindingType.GHOST_SECTION, "{% section 'klaviyo-section' %}")).toBe(
      Severity.LOW,
    );
  });

  it("returns LOW for ORPHAN_ASSET by default", () => {
    expect(classifySeverity(FindingType.ORPHAN_ASSET, "some-unused-asset.js")).toBe(Severity.LOW);
  });

  // -------------------------------------------------------------------------
  // Liquid comment downgrade
  // -------------------------------------------------------------------------

  it("downgrades GHOST_SCRIPT to LOW when inside a Liquid comment", () => {
    const snippet =
      '{% comment %}\n  <script src="//cdn.klaviyo.com/js/klaviyo.js"></script>\n{% endcomment %}';
    expect(classifySeverity(FindingType.GHOST_SCRIPT, snippet)).toBe(Severity.LOW);
  });

  it("downgrades GHOST_STYLE to LOW when inside a whitespace-stripping Liquid comment", () => {
    const snippet =
      '{%- comment -%}\n  <link rel="stylesheet" href="//cdn.loox.io/style.css">\n{%- endcomment -%}';
    expect(classifySeverity(FindingType.GHOST_STYLE, snippet)).toBe(Severity.LOW);
  });

  it("downgrades GHOST_SNIPPET to LOW when inside a Liquid comment", () => {
    const snippet = "{% comment %}\n  {% render 'klaviyo-onsite' %}\n{% endcomment %}";
    expect(classifySeverity(FindingType.GHOST_SNIPPET, snippet)).toBe(Severity.LOW);
  });

  // -------------------------------------------------------------------------
  // Print-only stylesheet downgrade
  // -------------------------------------------------------------------------

  it('downgrades GHOST_STYLE to LOW when stylesheet has media="print"', () => {
    const snippet = '<link rel="stylesheet" media="print" href="//cdn.klaviyo.com/print.css">';
    expect(classifySeverity(FindingType.GHOST_STYLE, snippet)).toBe(Severity.LOW);
  });

  it("downgrades GHOST_STYLE to LOW when stylesheet has media='print' (single quotes)", () => {
    const snippet = "<link rel='stylesheet' media='print' href='//cdn.klaviyo.com/print.css'>";
    expect(classifySeverity(FindingType.GHOST_STYLE, snippet)).toBe(Severity.LOW);
  });

  it('does NOT downgrade GHOST_SCRIPT to LOW for media="print" (only applies to GHOST_STYLE)', () => {
    const snippet = '<script src="//cdn.klaviyo.com/js.js" media="print"></script>';
    expect(classifySeverity(FindingType.GHOST_SCRIPT, snippet)).toBe(Severity.HIGH);
  });

  it("liquid comment check takes precedence over print-only check", () => {
    const snippet =
      '{% comment %}<link rel="stylesheet" media="print" href="//cdn.x.com/a.css">{% endcomment %}';
    expect(classifySeverity(FindingType.GHOST_STYLE, snippet)).toBe(Severity.LOW);
  });
});
