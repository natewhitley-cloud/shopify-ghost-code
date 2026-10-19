/**
 * Tests for app/components/PlanTile.tsx (gc-4wvb), ported from FraudPilot's
 * PlanTile tests. Rendered with react-dom/server (no DOM environment).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";

import { PlanTile } from "../../app/components/PlanTile";
import type { PlanTileProps } from "../../app/components/PlanTile";
import { BORDER_DEFAULT, COLOR_INFO } from "../../app/styles/shared";

function render(props: PlanTileProps): string {
  return renderToStaticMarkup(createElement(PlanTile, props));
}

/** The outer tile's inline style attribute. */
function cardStyle(html: string): string {
  return /^<div style="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe("PlanTile", () => {
  it("renders the name, price and every feature in order", () => {
    const html = render({ name: "Standard", price: "$9 / month", features: ["One", "Two"] });
    expect(html).toMatch(/<h3 style="[^"]*">Standard<\/h3>/);
    expect(html).toContain(">$9 / month</p>");
    expect([...html.matchAll(/<s-list-item>([^<]*)<\/s-list-item>/g)].map((m) => m[1])).toEqual([
      "One",
      "Two",
    ]);
  });

  it("renders an empty features list without crashing", () => {
    const html = render({ name: "Free", price: "$0 / month", features: [] });
    expect(html).toContain("<s-unordered-list></s-unordered-list>");
  });

  it("renders the badge only when given", () => {
    expect(render({ name: "Free", price: "$0", features: ["x"], badge: "Current plan" })).toContain(
      ">Current plan</span>",
    );
    expect(render({ name: "Free", price: "$0", features: ["x"] })).not.toContain("<span");
  });

  it("current: a 2px info border plus a ring", () => {
    const style = cardStyle(render({ name: "P", price: "$29", features: ["x"], current: true }));
    expect(style).toContain(`border:2px solid ${COLOR_INFO}`);
    expect(style).toContain(`box-shadow:0 0 0 1px ${COLOR_INFO}`);
  });

  it("not current: a 1px default border and no ring", () => {
    const style = cardStyle(render({ name: "F", price: "$0", features: ["x"] }));
    expect(style).toContain(`border:1px solid ${BORDER_DEFAULT}`);
    expect(style).not.toContain("box-shadow");
  });

  it("the header block uses a min-height so dividers align across tiles", () => {
    const html = render({ name: "F", price: "$0", features: ["x"] });
    expect(html).toMatch(/<div style="min-height:88px[^"]*"><h3/);
    expect(html).toContain("<hr");
  });

  it("CTA: an anchor with target=_top wrapping the button, primary by default", () => {
    const html = render({
      name: "S",
      price: "$9",
      features: ["x"],
      cta: { label: "Upgrade to Standard", url: "https://example.test/pricing" },
    });
    expect(html).toMatch(
      /<a href="https:\/\/example\.test\/pricing" target="_top" rel="noreferrer"><s-button variant="primary">Upgrade to Standard<\/s-button><\/a>/,
    );
  });

  it("CTA: honours the secondary variant", () => {
    const html = render({
      name: "F",
      price: "$0",
      features: ["x"],
      cta: { label: "Downgrade to Free", url: "u", variant: "secondary" },
    });
    expect(html).toContain('<s-button variant="secondary">Downgrade to Free</s-button>');
  });

  it("no CTA: no anchor and no button", () => {
    const html = render({ name: "F", price: "$0", features: ["x"] });
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<s-button");
  });

  it("uses no hex colours outside the shared tokens", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../app/components/PlanTile.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
