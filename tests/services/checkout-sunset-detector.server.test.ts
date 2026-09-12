/**
 * Unit tests for the checkout-extensibility sunset detector (gc-b3c).
 *
 * The detector is PURE: it reads only the already-fetched theme files and emits
 * at most one CHECKOUT_SUNSET finding.
 *
 * Coverage:
 *   - happy path: checkout.liquid with scripts → one finding, subtype "scripts"
 *   - depth subtypes: tracking / snippets / content-injection / plain layout
 *   - edge: no checkout.liquid → no finding
 *   - edge: empty / whitespace / comment-only checkout.liquid → no finding
 *   - commented-out signals are not counted as live customization
 *   - finding shape: filename, type, HIGH severity, evidence snippet, subtype tag
 */

import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { detectCheckoutSunset } from "../../app/services/checkout-sunset-detector.server";
import type { ThemeFile } from "../../app/services/scan-engine.server";

const CHECKOUT_PATH = "layout/checkout.liquid";

function file(content: string, filename = CHECKOUT_PATH): ThemeFile {
  return { filename, content };
}

// ---------------------------------------------------------------------------
// Check 1 — presence (with non-trivial content)
// ---------------------------------------------------------------------------

describe("detectCheckoutSunset — presence check", () => {
  it("emits no finding when layout/checkout.liquid is absent", () => {
    const findings = detectCheckoutSunset([
      file("<div>hi</div>", "layout/theme.liquid"),
      file("{{ content_for_layout }}", "sections/header.liquid"),
    ]);
    expect(findings).toEqual([]);
  });

  it("emits no finding for an empty checkout.liquid", () => {
    expect(detectCheckoutSunset([file("")])).toEqual([]);
  });

  it("emits no finding for a whitespace-only checkout.liquid", () => {
    expect(detectCheckoutSunset([file("\n\n   \t\n")])).toEqual([]);
  });

  it("emits no finding when checkout.liquid holds only comments", () => {
    const content = "{% comment %} old checkout {% endcomment %}\n<!-- legacy -->";
    expect(detectCheckoutSunset([file(content)])).toEqual([]);
  });

  it("emits exactly one finding for a non-trivial checkout.liquid", () => {
    const findings = detectCheckoutSunset([file("{{ content_for_layout }}")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.CHECKOUT_SUNSET);
    expect(findings[0].filename).toBe(CHECKOUT_PATH);
    expect(findings[0].severity).toBe(Severity.HIGH);
  });

  it("matches only the exact layout/checkout.liquid path, not lookalikes", () => {
    const findings = detectCheckoutSunset([
      file("<script>track()</script>", "snippets/checkout.liquid"),
      file("<script>track()</script>", "templates/checkout.liquid"),
    ]);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Check 2 — customization depth (subtype + description)
// ---------------------------------------------------------------------------

describe("detectCheckoutSunset — customization depth", () => {
  it('tags subtype "scripts" and describes script breakage for a <script> tag', () => {
    const findings = detectCheckoutSunset([
      file('<script src="https://cdn.example.com/x.js"></script>'),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("scripts");
    expect(findings[0].description).toContain("custom <script> code will stop executing");
    expect(findings[0].description).toContain("Checkout Extensibility");
  });

  it('tags subtype "tracking" for analytics snippets (no <script> tag)', () => {
    const findings = detectCheckoutSunset([file("{{ 'x' }} gtag('config', 'GA-1');")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("tracking");
    expect(findings[0].description).toContain("tracking and analytics pixels will stop firing");
  });

  it('tags subtype "snippets" for a {% render %} with no scripts/tracking', () => {
    const findings = detectCheckoutSunset([file("{% render 'checkout-extras' %}")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("snippets");
    expect(findings[0].description).toContain("custom snippets rendered into checkout");
  });

  it('tags subtype "content-injection" for content_for_* only', () => {
    const findings = detectCheckoutSunset([
      file("{{ content_for_header }}\n{{ content_for_layout }}"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("content-injection");
    expect(findings[0].description).toContain("content_for_*");
  });

  it('tags subtype "layout" for a non-trivial file with no recognized signals', () => {
    const findings = detectCheckoutSunset([file("<div class='wrap'>Checkout</div>")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("layout");
    // The generic (no-signal) description omits the "What breaks:" enumeration.
    expect(findings[0].description).not.toContain("What breaks:");
    expect(findings[0].description).toContain("Checkout Extensibility");
  });

  it("picks the highest-impact subtype and lists every matching clause", () => {
    // scripts + render + content_for all present → subtype is the top-priority
    // "scripts", but the description enumerates all three.
    const content = [
      "{{ content_for_header }}",
      "{% render 'extras' %}",
      "<script>fbq('track', 'Purchase');</script>",
    ].join("\n");
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("scripts");
    expect(findings[0].description).toContain("custom <script> code will stop executing");
    expect(findings[0].description).toContain("custom snippets rendered into checkout");
    expect(findings[0].description).toContain("content_for_*");
  });

  it("does not count a commented-out <script> as a live customization", () => {
    // Only a commented script + one live content_for injection point.
    const content = "<!-- <script>old()</script> -->\n{{ content_for_layout }}";
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    // The live signal is content_for, not the commented script.
    expect(findings[0].appName).toBe("content-injection");
    expect(findings[0].description).not.toContain("<script> code will stop executing");
  });
});

// ---------------------------------------------------------------------------
// Finding evidence
// ---------------------------------------------------------------------------

describe("detectCheckoutSunset — evidence", () => {
  it("anchors the snippet at the first line carrying a detected signal", () => {
    const content = ["<p>hi</p>", "<script>go()</script>", "<p>bye</p>"].join("\n");
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    // The only signal is the <script> on line 2.
    expect(findings[0].lineNumber).toBe(2);
    expect(findings[0].codeSnippet).toContain("<script>go()</script>");
  });

  it("falls back to line 1 for a plain layout file with no signals", () => {
    const findings = detectCheckoutSunset([file("<div>Checkout</div>")]);
    expect(findings[0].lineNumber).toBe(1);
  });

  it("anchors evidence at the LIVE signal, not an earlier commented occurrence", () => {
    // <script> appears first inside an HTML comment (line 1) and again as live
    // code (line 5). The evidence must resolve to the live line, so the finding
    // never shows commented-out code as proof of a live-breakage claim.
    const content = [
      "<!-- <script>legacyThing()</script> -->",
      "{{ content_for_layout }}",
      "<p>filler</p>",
      "<p>filler</p>",
      "<script>trackingPixel()</script>",
    ].join("\n");
    const findings = detectCheckoutSunset([file(content)]);
    expect(findings).toHaveLength(1);
    // Dominant signal is "scripts"; evidence anchors at the live script (line 5),
    // not the commented one (line 1).
    expect(findings[0].appName).toBe("scripts");
    expect(findings[0].lineNumber).toBe(5);
    expect(findings[0].codeSnippet).toContain("trackingPixel()");
    expect(findings[0].codeSnippet).not.toContain("legacyThing()");
  });

  it("emits no em-dash or en-dash in the description", () => {
    const findings = detectCheckoutSunset([file("<script>x()</script>")]);
    expect(findings[0].description).not.toMatch(/[—–]/);
  });
});
