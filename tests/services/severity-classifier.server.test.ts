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

  it("returns HIGH for GHOST_HREFLANG by default", () => {
    expect(
      classifySeverity(
        FindingType.GHOST_HREFLANG,
        '<link rel="alternate" hreflang="fr" href="https://fr.example.com/">',
      ),
    ).toBe(Severity.HIGH);
  });

  it("returns LOW for ORPHAN_ASSET by default", () => {
    expect(classifySeverity(FindingType.ORPHAN_ASSET, "some-unused-asset.js")).toBe(Severity.LOW);
  });

  it("returns MEDIUM for DUPLICATE_META by default", () => {
    expect(
      classifySeverity(FindingType.DUPLICATE_META, '<meta name="description" content="duplicate">'),
    ).toBe(Severity.MEDIUM);
  });

  it("returns MEDIUM for GHOST_JSON_LD by default", () => {
    expect(
      classifySeverity(
        FindingType.GHOST_JSON_LD,
        '<script type="application/ld+json">{"@type":"Product"}</script>',
      ),
    ).toBe(Severity.MEDIUM);
  });

  it("returns MEDIUM for GHOST_TRANSLATION by default", () => {
    expect(classifySeverity(FindingType.GHOST_TRANSLATION, 'title: "Titre"')).toBe(Severity.MEDIUM);
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

  it("downgrades GHOST_HREFLANG to LOW when inside a Liquid comment", () => {
    const snippet =
      '{% comment %}\n  <link rel="alternate" hreflang="fr" href="https://fr.example.com/">\n{% endcomment %}';
    expect(classifySeverity(FindingType.GHOST_HREFLANG, snippet)).toBe(Severity.LOW);
  });

  it("downgrades DUPLICATE_META to LOW when inside a Liquid comment", () => {
    const snippet =
      '{% comment %}\n  <meta name="description" content="duplicate">\n{% endcomment %}';
    expect(classifySeverity(FindingType.DUPLICATE_META, snippet)).toBe(Severity.LOW);
  });

  it("downgrades GHOST_JSON_LD to LOW when inside a Liquid comment", () => {
    const snippet =
      '{% comment %}\n  <script type="application/ld+json">{"@type":"Product"}</script>\n{% endcomment %}';
    expect(classifySeverity(FindingType.GHOST_JSON_LD, snippet)).toBe(Severity.LOW);
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

  // -------------------------------------------------------------------------
  // GHOST_TITLE nuance: page_title downgrade
  // -------------------------------------------------------------------------

  it("returns HIGH for GHOST_TITLE by default", () => {
    const snippet = "<title>{{ shop.name }} — Buy Now</title>";
    expect(classifySeverity(FindingType.GHOST_TITLE, snippet, "Empty title tag")).toBe(
      Severity.HIGH,
    );
  });

  it("downgrades GHOST_TITLE to MEDIUM when description contains page_title", () => {
    const snippet = "<title>{{ page_title }} — {{ shop.name }}</title>";
    expect(
      classifySeverity(
        FindingType.GHOST_TITLE,
        snippet,
        "Unresolved Liquid variable in title tag with page_title",
      ),
    ).toBe(Severity.MEDIUM);
  });

  it("does NOT downgrade GHOST_TITLE when page_title is in snippet but not description", () => {
    const snippet = "<title>{{ page_title }} — {{ shop.name }}</title>";
    expect(classifySeverity(FindingType.GHOST_TITLE, snippet, "Empty title tag")).toBe(
      Severity.HIGH,
    );
  });

  // -------------------------------------------------------------------------
  // GHOST_OG nuance: og:image upgrade
  // -------------------------------------------------------------------------

  it("returns MEDIUM for GHOST_OG by default", () => {
    const snippet = '<meta property="og:title" content="{{ page_title }}">';
    expect(classifySeverity(FindingType.GHOST_OG, snippet, "Empty og:title meta tag")).toBe(
      Severity.MEDIUM,
    );
  });

  it("upgrades GHOST_OG to HIGH when description contains og:image", () => {
    const snippet = '<meta property="og:image" content="{{ product.featured_image | img_url }}">';
    expect(classifySeverity(FindingType.GHOST_OG, snippet, "Empty og:image meta tag")).toBe(
      Severity.HIGH,
    );
  });

  it("does NOT upgrade GHOST_OG when og:image is in snippet but not description", () => {
    const snippet =
      '<meta property="og:title" content="">\n<meta property="og:image" content="{{ product.featured_image }}">';
    expect(classifySeverity(FindingType.GHOST_OG, snippet, "Empty og:title meta tag")).toBe(
      Severity.MEDIUM,
    );
  });

  it("liquid comment check takes precedence over print-only check", () => {
    const snippet =
      '{% comment %}<link rel="stylesheet" media="print" href="//cdn.x.com/a.css">{% endcomment %}';
    expect(classifySeverity(FindingType.GHOST_STYLE, snippet)).toBe(Severity.LOW);
  });
});
