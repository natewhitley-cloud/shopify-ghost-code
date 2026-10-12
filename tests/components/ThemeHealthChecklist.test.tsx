/**
 * Tests for app/components/ThemeHealthChecklist.tsx (gc-i6du): the checklist
 * as the merchant sees it. Static render; no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, it, expect } from "vitest";

import {
  THEME_HEALTH_HEADING,
  THEME_HEALTH_INTRO,
  ThemeHealthChecklist,
} from "../../app/components/ThemeHealthChecklist";
import type { HealthRow } from "../../app/lib/theme-health";

function render(rows?: HealthRow[]): string {
  const Stub = createRoutesStub([
    { path: "/app", Component: () => <ThemeHealthChecklist rows={rows} /> },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/app"]} />);
}

const row = (overrides: Partial<HealthRow>): HealthRow => ({
  key: "scripts-styles",
  label: "Leftover scripts and styles",
  checks: "Scripts, stylesheets, fonts and app calls from apps you removed.",
  status: "clean",
  statusLabel: "Clean",
  count: 0,
  detail: null,
  href: null,
  ...overrides,
});

describe("ThemeHealthChecklist", () => {
  it("renders nothing for no rows (and for missing loader data)", () => {
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("is a labelled region with a real heading, an intro and one list item per row", () => {
    const html = render([row({}), row({ key: "tracking", label: "Tracking still running" })]);
    expect(html).toContain('<section aria-labelledby="theme-health-heading"');
    expect(html).toMatch(
      new RegExp(`<h2 id="theme-health-heading"[^>]*>${THEME_HEALTH_HEADING}</h2>`),
    );
    expect(html).toContain(THEME_HEALTH_INTRO);
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toMatch(/<h3[^>]*>Leftover scripts and styles<\/h3>/);
    // Not a live region: Home polls every 3s while a scan runs.
    expect(html).not.toMatch(/aria-live|role="status"/);
  });

  it("a clean row: a success badge, what it checks, and no link", () => {
    const html = render([row({})]);
    expect(html).toContain('<s-badge tone="success">Clean</s-badge>');
    expect(html).toContain("Scripts, stylesheets, fonts and app calls from apps you removed.");
    expect(html).not.toContain("View findings");
  });

  it("an issues row: a caution badge, the cost line and a labelled link", () => {
    const html = render([
      row({
        status: "issues",
        statusLabel: "4 issues",
        count: 4,
        detail: "4 extra requests to apps you removed, on every page that loads them.",
        href: "/app/scans/scan-1?type=GHOST_SCRIPT",
      }),
    ]);
    expect(html).toContain('<s-badge tone="caution">4 issues</s-badge>');
    expect(html).toContain("4 extra requests to apps you removed");
    expect(html).toMatch(
      /<a[^>]*href="\/app\/scans\/scan-1\?type=GHOST_SCRIPT"[^>]*>View findings<\/a>/,
    );
    expect(html).toContain('aria-label="View findings: Leftover scripts and styles"');
  });

  it("malicious code is critical; every other issue is a caution", () => {
    const html = render([
      row({
        key: "malicious",
        label: "Known malicious code",
        status: "issues",
        statusLabel: "1 issue",
      }),
    ]);
    expect(html).toContain('<s-badge tone="critical">1 issue</s-badge>');
  });

  it.each([
    ["partial", "None found", "neutral"],
    ["not_checked", "Not checked", "neutral"],
    ["info", "2 unpublished", "info"],
  ] as const)("a %s row uses a %s / %s badge", (status, statusLabel, tone) => {
    expect(render([row({ status, statusLabel })])).toContain(
      `<s-badge tone="${tone}">${statusLabel}</s-badge>`,
    );
  });

  it("escapes theme-controlled text (a theme name is not markup)", () => {
    const html = render([
      row({
        key: "theme",
        label: "Theme type and version",
        detail: "<img src=x onerror=alert(1)>",
      }),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("uses the shared design tokens: no hex color is written in the component", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "app", "components", "ThemeHealthChecklist.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).toContain('from "../styles/shared"');
  });

  it("has no score, percentage or 'x of y'", () => {
    const html = render([
      row({ status: "issues", statusLabel: "4 issues", count: 4, detail: "4 extra requests." }),
      row({ key: "tracking", label: "Tracking still running" }),
    ]);
    expect(html).not.toMatch(/%|\bscore\b|out of|\b\d+ of \d+\b/i);
  });
});
