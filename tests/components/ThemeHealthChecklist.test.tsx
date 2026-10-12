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
import { HEALTH_CATEGORIES, partitionHealthRows } from "../../app/lib/theme-health";
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

const CHECKS = "Scripts, stylesheets, fonts and app calls from apps you removed.";

/** The closed "Clean:" group, or "" when there is none. */
function foldOf(html: string): string {
  const start = html.indexOf("<details");
  return start === -1 ? "" : html.slice(start, html.indexOf("</details>", start));
}

/** The summary line of the fold, or null when there is none. */
function summaryOf(html: string): string | null {
  return html.match(/<summary[^>]*>([^<]*)<\/summary>/)?.[1] ?? null;
}

/** Everything outside the fold: the rows shown in full. */
function visibleOf(html: string): string {
  return html.replace(/<details[\s\S]*<\/details>/, "");
}

/**
 * One row of every status, malicious clean, and the two rows that are not
 * findings (the theme row is "clean" here, as it is for an Online Store 2.0
 * theme). Only "tracking" and "store-data" may fold.
 */
const MIXED: HealthRow[] = [
  row({ key: "malicious", label: "Known malicious code", checks: "Malicious checks." }),
  row({
    key: "liquid-errors",
    label: "Liquid errors on your homepage",
    checks: "Liquid checks.",
    status: "not_checked",
    statusLabel: "Not checked",
    detail: "This wasn't checked on your last scan. Run a new scan.",
  }),
  row({
    key: "shopper-visible",
    label: "Broken links and leftover app text",
    checks: "Shopper checks.",
    status: "issues",
    statusLabel: "6 issues",
    count: 6,
    detail: "6 pieces of leftover app text.",
    href: "/app/scans/scan-1",
  }),
  row({
    key: "snippets-sections",
    label: "Unused snippets and sections",
    checks: "Snippet checks.",
    status: "partial",
    statusLabel: "None found",
    detail: "Old checkout code is checked on Standard and Professional.",
  }),
  row({ key: "tracking", label: "Tracking still running", checks: "Tracking checks." }),
  row({ key: "store-data", label: "Store data left behind", checks: "Store data checks." }),
  row({
    key: "theme",
    label: "Theme type and version",
    checks: "Theme checks.",
    statusLabel: "Online Store 2.0",
    detail: "Dawn by Shopify",
  }),
  row({
    key: "unpublished-themes",
    label: "Unpublished themes",
    checks: "Unpublished checks.",
    status: "info",
    statusLabel: "2 unpublished",
    detail: "Your store has 3 themes.",
  }),
];

describe("partitionHealthRows", () => {
  it("folds only clean finding categories other than malicious, keeping the order", () => {
    const { visible, folded } = partitionHealthRows(MIXED);
    expect(folded.map((r) => r.key)).toEqual(["tracking", "store-data"]);
    expect(visible.map((r) => r.key)).toEqual([
      "malicious",
      "liquid-errors",
      "shopper-visible",
      "snippets-sections",
      "theme",
      "unpublished-themes",
    ]);
  });

  it.each(["issues", "partial", "not_checked", "info"] as const)(
    "a %s row never folds, in any category",
    (status) => {
      const rows = [
        ...HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label, status })),
        row({ key: "theme", status }),
        row({ key: "unpublished-themes", status }),
      ];
      expect(partitionHealthRows(rows)).toEqual({ visible: rows, folded: [] });
    },
  );

  it("every category clean: malicious, theme and unpublished stay visible, the rest fold", () => {
    const rows = [
      ...HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label })),
      row({ key: "theme", label: "Theme type and version" }),
      row({ key: "unpublished-themes", label: "Unpublished themes" }),
    ];
    const { visible, folded } = partitionHealthRows(rows);
    expect(visible.map((r) => r.key)).toEqual(["malicious", "theme", "unpublished-themes"]);
    expect(folded.map((r) => r.key)).toEqual(
      HEALTH_CATEGORIES.map((c) => c.key).filter((key) => key !== "malicious"),
    );
    expect(folded).toHaveLength(8);
  });
});

describe("ThemeHealthChecklist", () => {
  it("renders nothing for no rows (and for missing loader data)", () => {
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("is a labelled region with a real heading, an intro and one list item per row", () => {
    const html = render([
      row({ status: "issues", statusLabel: "4 issues" }),
      row({ key: "tracking", label: "Tracking still running" }),
    ]);
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
    expect(html).toContain(CHECKS);
    expect(html).not.toContain("View findings");
    expect(html).not.toContain("<a");
  });

  it("an issues row: a caution badge, the cost line, and its label is the link", () => {
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
    // The label is the link, inside the heading, named with the visible label.
    expect(html).toMatch(
      /<h3[^>]*><a[^>]*href="\/app\/scans\/scan-1\?type=GHOST_SCRIPT"[^>]*>Leftover scripts and styles<\/a><\/h3>/,
    );
    expect(html).toContain('aria-label="View findings: Leftover scripts and styles"');
    // No standalone "View findings" line: the words are only in the link's name.
    expect(html).not.toContain(">View findings<");
    expect(html.match(/View findings/g)).toHaveLength(1);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("a visible row shows ONE secondary line: the detail when there is one, else what it checks", () => {
    const withDetail = render([
      row({ status: "issues", statusLabel: "4 issues", detail: "4 extra requests." }),
    ]);
    expect(withDetail).toContain("4 extra requests.");
    expect(withDetail).not.toContain(CHECKS);

    const withoutDetail = render([row({ status: "issues", statusLabel: "4 issues" })]);
    expect(withoutDetail).toContain(CHECKS);

    // A clean row that stays visible (malicious) also falls back to what it checks.
    const malicious = render([row({ key: "malicious", label: "Known malicious code" })]);
    expect(malicious).not.toContain("<details");
    expect(malicious).toContain(CHECKS);
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

  describe("the Clean fold", () => {
    it("names exactly the clean finding categories, in order, and nothing else (no false Clean)", () => {
      const html = render(MIXED);
      expect(summaryOf(html)).toBe("Clean: Tracking still running, Store data left behind");

      // Inside the fold: only those two rows, each with its label, what it
      // checked and a Clean badge.
      const fold = foldOf(html);
      expect(fold.match(/<li /g)).toHaveLength(2);
      expect(fold).toMatch(/<h3[^>]*>Tracking still running<\/h3>/);
      expect(fold).toContain("Tracking checks.");
      expect(fold).toMatch(/<h3[^>]*>Store data left behind<\/h3>/);
      expect(fold).toContain("Store data checks.");
      expect(fold.match(/<s-badge tone="success">Clean<\/s-badge>/g)).toHaveLength(2);
      expect(fold.match(/<s-badge/g)).toHaveLength(2);
      for (const label of [
        "Known malicious code",
        "Liquid errors on your homepage",
        "Broken links and leftover app text",
        "Unused snippets and sections",
        "Theme type and version",
        "Unpublished themes",
        "Not checked",
        "None found",
        "6 issues",
        "Online Store 2.0",
      ]) {
        expect(fold, `"${label}" must not be in the Clean group`).not.toContain(label);
      }

      // Outside it: every other row, in order, with its own badge.
      const visible = visibleOf(html);
      expect(visible.match(/<li /g)).toHaveLength(6);
      expect([...visible.matchAll(/<s-badge tone="([a-z]+)">([^<]*)<\/s-badge>/g)]).toEqual(
        [
          ["success", "Clean"],
          ["neutral", "Not checked"],
          ["caution", "6 issues"],
          ["neutral", "None found"],
          ["success", "Online Store 2.0"],
          ["info", "2 unpublished"],
        ].map(([tone, label]) => expect.arrayContaining([tone, label])),
      );
      expect(visible).toMatch(/<h3[^>]*>Known malicious code<\/h3>/);
      expect(visible).toMatch(/<h3[^>]*>Theme type and version<\/h3>/);
      expect(visible).not.toContain("Tracking still running");
      expect(visible).not.toContain("Store data left behind");
    });

    it("comes after the visible list and is closed by default", () => {
      const html = render(MIXED);
      expect(html.indexOf("<details")).toBeGreaterThan(html.indexOf("Unpublished themes"));
      expect(html).toMatch(/<details[^>]*><summary/);
      expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    });

    it("the summary names the checks and never counts them", () => {
      const rows = [
        ...HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label })),
        row({ key: "theme", label: "Theme type and version" }),
        row({ key: "unpublished-themes", label: "Unpublished themes" }),
      ];
      const html = render(rows);
      const summary = summaryOf(html);
      expect(summary).toBe(
        `Clean: ${HEALTH_CATEGORIES.filter((c) => c.key !== "malicious")
          .map((c) => c.label)
          .join(", ")}`,
      );
      expect(summary).not.toMatch(/\d/);
      // Malicious, the theme and the unpublished themes still show in full.
      expect(visibleOf(html).match(/<li /g)).toHaveLength(3);
      expect(visibleOf(html)).toMatch(/<h3[^>]*>Known malicious code<\/h3>/);
    });

    it("is not rendered when nothing folds", () => {
      const html = render(MIXED.filter((r) => r.key !== "tracking" && r.key !== "store-data"));
      expect(html).not.toContain("<details");
      expect(html).not.toContain("<summary");
      expect(html).not.toContain("Clean:");
      expect(html.match(/<li /g)).toHaveLength(6);
    });

    it("a folded row shows what it checked, never a detail line", () => {
      const fold = foldOf(render([row({ detail: "Not a real builder output." })]));
      expect(fold).toContain(CHECKS);
      expect(fold).not.toContain("Not a real builder output.");
    });
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

  it("has no score, percentage, 'x of y' or em dash", () => {
    const html = render(MIXED);
    expect(html).not.toMatch(/%|\bscore\b|\bgrade\b|out of|\b\d+ of \d+\b/i);
    expect(html).not.toContain("—");
  });
});
