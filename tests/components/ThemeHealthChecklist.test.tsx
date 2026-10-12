/**
 * Tests for app/components/ThemeHealthChecklist.tsx (gc-i6du): the slim strip
 * the merchant sees on Home (theme facts, clean checks by name, checks that
 * did not run), and groupHealthRows, which decides what goes where. Static
 * render; no network.
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
import { groupHealthRows, HEALTH_CATEGORIES } from "../../app/lib/theme-health";
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

/** The content of the group labelled `label` (its dd), or null when the group is absent. */
function groupOf(html: string, label: string): string | null {
  return html.match(new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>([\\s\\S]*?)</dd>`))?.[1] ?? null;
}

/** Every group label in the section, in order. */
function groupLabels(html: string): string[] {
  return [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]);
}

/** The Clean line as text, or null when there is no Clean group. */
function cleanLine(html: string): string | null {
  const group = groupOf(html, "Clean");
  return group === null ? null : group.replace(/<[^>]+>/g, "");
}

const NOT_RUN = "This wasn't checked on your last scan. Run a new scan.";
const PLAN_GAP = "Old checkout code is checked on Standard and Professional.";
const VINTAGE =
  "Debut 17.14.0 by Shopify is a vintage theme, not Online Store 2.0. It can't use app blocks, so an app that adds something to a page has to write its code into your theme files, and that code stays there when you remove the app. App embeds still work on it.";

/** React escapes an apostrophe in text. */
const esc = (text: string) => text.replace(/'/g, "&#x27;");

const THEME_OS2 = row({
  key: "theme",
  label: "Theme type and version",
  checks: "Theme checks.",
  statusLabel: "Online Store 2.0",
  detail: "Dawn 15.2.0 by Shopify",
});
const THEME_VINTAGE = row({
  key: "theme",
  label: "Theme type and version",
  status: "issues",
  statusLabel: "Vintage theme",
  detail: VINTAGE,
});
const THEME_INFO = row({
  key: "theme",
  label: "Theme type and version",
  status: "info",
  statusLabel: "Type not detected",
  detail: "Dawn - live",
});
const THEME_NOT_CHECKED = row({
  key: "theme",
  label: "Theme type and version",
  status: "not_checked",
  statusLabel: "Not checked",
  detail: "Run a new scan to see your theme's name, version and type.",
});
const UNPUBLISHED = row({
  key: "unpublished-themes",
  label: "Unpublished themes",
  checks: "Unpublished checks.",
  status: "info",
  statusLabel: "2 unpublished",
  detail: "Your store has 3 themes. Shopify allows 20 (more on Plus).",
});

const MALICIOUS = row({
  key: "malicious",
  label: "Known malicious code",
  checks: "Malicious checks.",
});
const LIQUID_NOT_CHECKED = row({
  key: "liquid-errors",
  label: "Liquid errors on your homepage",
  checks: "Liquid checks.",
  status: "not_checked",
  statusLabel: "Not checked",
  detail: NOT_RUN,
});
const SHOPPER_ISSUES = row({
  key: "shopper-visible",
  label: "Broken links and leftover app text",
  checks: "Shopper checks.",
  status: "issues",
  statusLabel: "6 issues",
  count: 6,
  detail: "6 pieces of leftover app text.",
  href: "/app/scans/scan-1",
});
const SCRIPTS_ISSUES = row({
  status: "issues",
  statusLabel: "12 issues",
  count: 12,
  detail: "12 extra requests to apps you removed, on every page that loads them.",
  href: "/app/scans/scan-1?type=GHOST_SCRIPT",
});
const SNIPPETS_PARTIAL = row({
  key: "snippets-sections",
  label: "Leftover snippets and sections",
  checks: "Snippet checks.",
  status: "partial",
  statusLabel: "None found",
  detail: PLAN_GAP,
});
const TRACKING = row({
  key: "tracking",
  label: "Tracking still running",
  checks: "Tracking checks.",
});
const STORE_DATA = row({
  key: "store-data",
  label: "Store data left behind",
  checks: "Store data checks.",
});

/**
 * One finding category of every status the builder makes (clean, not_checked,
 * issues, partial), malicious clean, and the two rows that are not findings.
 */
const MIXED: HealthRow[] = [
  MALICIOUS,
  LIQUID_NOT_CHECKED,
  SHOPPER_ISSUES,
  SCRIPTS_ISSUES,
  SNIPPETS_PARTIAL,
  TRACKING,
  STORE_DATA,
  THEME_OS2,
  UNPUBLISHED,
];

const keys = (rows: readonly HealthRow[]) => rows.map((r) => r.key);

describe("groupHealthRows", () => {
  it("one row of every status: the exact contents of each group, in order", () => {
    const groups = groupHealthRows(MIXED);
    expect(groups.theme).toBe(THEME_OS2);
    expect(groups.unpublished).toBe(UNPUBLISHED);
    expect(groups.clean).toEqual([MALICIOUS, TRACKING, STORE_DATA]);
    expect(groups.gaps).toEqual([LIQUID_NOT_CHECKED, SNIPPETS_PARTIAL]);
    expect(groups.hasPartial).toBe(true);
  });

  it("no rows: every group is empty", () => {
    expect(groupHealthRows([])).toEqual({
      theme: null,
      unpublished: null,
      clean: [],
      gaps: [],
      hasPartial: false,
    });
  });

  it("every category clean: all nine are clean, malicious included, in category order", () => {
    const rows = [...HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label })), THEME_OS2];
    const groups = groupHealthRows(rows);
    expect(keys(groups.clean)).toEqual(HEALTH_CATEGORIES.map((c) => c.key));
    expect(groups.clean).toHaveLength(9);
    expect(groups.clean[0].key).toBe("malicious");
    expect(groups.gaps).toEqual([]);
    expect(groups.hasPartial).toBe(false);
  });

  // THE false-Clean guard: only a status of exactly "clean" is ever clean.
  it.each(["issues", "partial", "not_checked", "info"] as const)(
    "a %s row is never clean, in any category",
    (status) => {
      const rows = HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label, status }));
      expect(groupHealthRows(rows).clean).toEqual([]);
    },
  );

  it("issues rows (the lanes' duplicates) are in no group, malicious included", () => {
    const rows = HEALTH_CATEGORIES.map((c) =>
      row({ key: c.key, label: c.label, status: "issues", statusLabel: "2 issues", count: 2 }),
    );
    expect(groupHealthRows(rows)).toEqual({
      theme: null,
      unpublished: null,
      clean: [],
      gaps: [],
      hasPartial: false,
    });
  });

  it("an info row in a finding category is in no group", () => {
    const groups = groupHealthRows([row({ status: "info", statusLabel: "A fact" })]);
    expect(groups.clean).toEqual([]);
    expect(groups.gaps).toEqual([]);
  });

  it("gaps hold not_checked and partial rows; hasPartial is true only when one is partial", () => {
    const notChecked = groupHealthRows([LIQUID_NOT_CHECKED, TRACKING]);
    expect(notChecked.gaps).toEqual([LIQUID_NOT_CHECKED]);
    expect(notChecked.hasPartial).toBe(false);

    const partial = groupHealthRows([SNIPPETS_PARTIAL, TRACKING]);
    expect(partial.gaps).toEqual([SNIPPETS_PARTIAL]);
    expect(partial.hasPartial).toBe(true);

    expect(groupHealthRows([TRACKING]).hasPartial).toBe(false);
  });

  it.each([
    ["os2 (clean)", THEME_OS2],
    ["vintage (issues)", THEME_VINTAGE],
    ["type not detected (info)", THEME_INFO],
    ["not checked", THEME_NOT_CHECKED],
  ])("the theme row, %s, is the theme and never clean or a gap", (_name, theme) => {
    const groups = groupHealthRows([TRACKING, theme, UNPUBLISHED]);
    expect(groups.theme).toBe(theme);
    expect(groups.unpublished).toBe(UNPUBLISHED);
    expect(groups.clean).toEqual([TRACKING]);
    expect(groups.gaps).toEqual([]);
    expect(groups.hasPartial).toBe(false);
  });

  it("the unpublished row is never clean or a gap, whatever its status", () => {
    for (const status of ["clean", "partial", "not_checked", "issues", "info"] as const) {
      const unpublished = { ...UNPUBLISHED, status };
      const groups = groupHealthRows([unpublished]);
      expect(groups.unpublished, status).toBe(unpublished);
      expect(groups.clean, status).toEqual([]);
      expect(groups.gaps, status).toEqual([]);
    }
  });

  it("a row with an unknown key is in no group", () => {
    const stray = { ...TRACKING, key: "something-else" } as unknown as HealthRow;
    const groups = groupHealthRows([stray]);
    expect(groups.clean).toEqual([]);
    expect(groups.gaps).toEqual([]);
  });
});

describe("ThemeHealthChecklist", () => {
  it("renders nothing for no rows (and for missing loader data)", () => {
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("renders nothing when every group is empty (only checks that found something)", () => {
    expect(render([SHOPPER_ISSUES, SCRIPTS_ISSUES])).toBe("");
    expect(
      render([{ ...MALICIOUS, status: "issues", statusLabel: "1 issue", count: 1 } as HealthRow]),
    ).toBe("");
    // A theme row and an unpublished row with nothing to say add no group either.
    expect(
      render([
        SHOPPER_ISSUES,
        { ...THEME_VINTAGE, detail: null },
        { ...UNPUBLISHED, detail: null },
      ]),
    ).toBe("");
  });

  it("is a labelled region with a real heading, an intro and a description list", () => {
    const html = render(MIXED);
    expect(html).toContain('<section aria-labelledby="theme-health-heading"');
    expect(html).toMatch(
      new RegExp(`<h2 id="theme-health-heading"[^>]*>${THEME_HEALTH_HEADING}</h2>`),
    );
    expect(THEME_HEALTH_INTRO).toBe("What your last scan checked, beyond the findings above.");
    expect(html).toContain(THEME_HEALTH_INTRO);
    expect(html.match(/<dl/g)).toHaveLength(1);
    expect(groupLabels(html)).toEqual(["Theme", "Clean", "Not fully checked"]);
    expect(html.match(/<dd/g)).toHaveLength(3);
    // Not a live region: Home polls every 3s while a scan runs.
    expect(html).not.toMatch(/aria-live|role="status"/);
  });

  it("is quiet text: no badge, no link, no fold, no list of rows", () => {
    const html = render(MIXED);
    expect(html).not.toContain("<s-badge");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("View findings");
    expect(html).not.toMatch(/<details|<summary|<li |<h3/);
  });

  describe("the Theme group", () => {
    it("an Online Store 2.0 theme: the title, a middle dot, then the type, on one line", () => {
      const html = render([THEME_OS2]);
      expect(groupLabels(html)).toEqual(["Theme"]);
      expect(groupOf(html, "Theme")).toMatch(
        /^<div[^>]*>Dawn 15\.2\.0 by Shopify · Online Store 2\.0<\/div>$/,
      );
    });

    it("a theme whose type was not detected: the title, then 'Type not detected'", () => {
      expect(groupOf(render([THEME_INFO]), "Theme")).toMatch(
        /^<div[^>]*>Dawn - live · Type not detected<\/div>$/,
      );
    });

    it("a vintage theme: its sentence shows as it is (a theme fact the lanes do not have)", () => {
      const group = groupOf(render([THEME_VINTAGE, SHOPPER_ISSUES]), "Theme")!;
      expect(group).toContain(esc(VINTAGE));
      // The sentence already says "vintage theme": the status label is not appended.
      expect(group).not.toContain("·");
      expect(group.match(/vintage theme/gi)).toHaveLength(1);
    });

    it("a theme that was not checked: its 'Run a new scan' line", () => {
      const group = groupOf(render([THEME_NOT_CHECKED]), "Theme")!;
      expect(group).toContain("Run a new scan to see your theme&#x27;s name, version and type.");
      expect(group).not.toContain("·");
      expect(group).not.toContain("Not checked");
    });

    it("the unpublished themes line sits under the theme line, on its own line", () => {
      const group = groupOf(render([THEME_OS2, UNPUBLISHED]), "Theme")!;
      expect(group).toMatch(
        /^<div[^>]*>Dawn 15\.2\.0 by Shopify · Online Store 2\.0<\/div><div[^>]*>Your store has 3 themes\. Shopify allows 20 \(more on Plus\)\.<\/div>$/,
      );
      // Its row label and badge text are not shown: the sentence says it all.
      expect(group).not.toContain("Unpublished themes");
      expect(group).not.toContain("2 unpublished");
    });

    it("shows with only the unpublished row", () => {
      const html = render([UNPUBLISHED]);
      expect(groupLabels(html)).toEqual(["Theme"]);
      expect(groupOf(html, "Theme")).toContain("Your store has 3 themes.");
    });

    it("never names the theme under Clean, even though an os2 theme row is 'clean'", () => {
      const html = render([TRACKING, THEME_OS2]);
      expect(cleanLine(html)).toBe("Tracking still running");
    });
  });

  describe("the Clean line", () => {
    it("names exactly the clean checks, in order, as plain text (no false Clean)", () => {
      const html = render(MIXED);
      expect(cleanLine(html)).toBe(
        "Known malicious code, Tracking still running, Store data left behind",
      );
      // Plain text: one element, nothing nested in it.
      expect(groupOf(html, "Clean")).toMatch(/^<div[^>]*>[^<]+<\/div>$/);
      for (const label of [
        "Liquid errors on your homepage",
        "Broken links and leftover app text",
        "Leftover scripts and styles",
        "Leftover snippets and sections",
        "Theme type and version",
        "Unpublished themes",
        "Online Store 2.0",
        "Dawn",
      ]) {
        expect(cleanLine(html), `"${label}" must not be on the Clean line`).not.toContain(label);
      }
    });

    it("includes malicious code when it is clean, first", () => {
      expect(cleanLine(render([MALICIOUS, TRACKING]))).toBe(
        "Known malicious code, Tracking still running",
      );
    });

    it("all nine checks clean: all nine names in category order, and no digit", () => {
      const html = render([
        ...HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label })),
        THEME_OS2,
        UNPUBLISHED,
      ]);
      const line = cleanLine(html);
      expect(line).toBe(HEALTH_CATEGORIES.map((c) => c.label).join(", "));
      expect(line).not.toMatch(/\d/);
      expect(groupLabels(html)).toEqual(["Theme", "Clean"]);
    });

    it("never counts the clean checks, and shows no per-check description", () => {
      const html = render(MIXED);
      expect(cleanLine(html)).not.toMatch(/\d/);
      for (const checks of ["Malicious checks.", "Tracking checks.", "Store data checks."]) {
        expect(html).not.toContain(checks);
      }
      // A clean row's detail (the builder never sets one) is not shown either.
      expect(render([row({ detail: "Not a real builder output." })])).not.toContain(
        "Not a real builder output.",
      );
    });

    it.each(["issues", "partial", "not_checked", "info"] as const)(
      "a %s row is never named under Clean",
      (status) => {
        const html = render([
          TRACKING,
          row({
            key: "seo-ai",
            label: "SEO and AI tags",
            status,
            statusLabel: "x",
            detail: "Why.",
          }),
        ]);
        expect(cleanLine(html)).toBe("Tracking still running");
      },
    );

    it("is not rendered when no check is clean", () => {
      const html = render([LIQUID_NOT_CHECKED, SHOPPER_ISSUES, THEME_OS2]);
      expect(groupLabels(html)).toEqual(["Theme", "Not checked"]);
      expect(cleanLine(html)).toBeNull();
      expect(html).not.toContain(">Clean<");
    });
  });

  describe("the Not checked group", () => {
    it("a check that did not run: its label, then the reason underneath", () => {
      const html = render([LIQUID_NOT_CHECKED, TRACKING]);
      expect(groupLabels(html)).toEqual(["Clean", "Not checked"]);
      expect(groupOf(html, "Not checked")).toMatch(
        new RegExp(
          `^<div><div[^>]*>Liquid errors on your homepage</div><div[^>]*>${esc(NOT_RUN).replace(/\./g, "\\.")}</div></div>$`,
        ),
      );
      expect(cleanLine(html)).toBe("Tracking still running");
    });

    it("is labelled 'Not checked' when every row in it is not_checked", () => {
      const html = render([
        LIQUID_NOT_CHECKED,
        row({ key: "seo-ai", label: "SEO and AI tags", status: "not_checked", detail: NOT_RUN }),
      ]);
      expect(groupLabels(html)).toEqual(["Not checked"]);
      expect(html).not.toContain("Not fully checked");
    });

    it("is labelled 'Not fully checked' when any row in it is partial", () => {
      const mixed = render([LIQUID_NOT_CHECKED, SNIPPETS_PARTIAL]);
      expect(groupLabels(mixed)).toEqual(["Not fully checked"]);
      const group = groupOf(mixed, "Not fully checked")!;
      expect(group).toContain("Liquid errors on your homepage");
      expect(group).toContain(esc(NOT_RUN));
      expect(group).toContain("Leftover snippets and sections");
      expect(group).toContain(PLAN_GAP);
      // In row order.
      expect(group.indexOf("Liquid errors")).toBeLessThan(group.indexOf("Leftover snippets"));

      expect(groupLabels(render([SNIPPETS_PARTIAL]))).toEqual(["Not fully checked"]);
    });

    it("a partial row is in this group with its reason, and never on the Clean line", () => {
      const html = render([SNIPPETS_PARTIAL, TRACKING]);
      expect(cleanLine(html)).toBe("Tracking still running");
      expect(groupOf(html, "Not fully checked")).toContain("Leftover snippets and sections");
      expect(groupOf(html, "Not fully checked")).toContain(PLAN_GAP);
      // The row's own badge text ("None found") is not shown: it reads as clean.
      expect(html).not.toContain("None found");
    });
  });

  describe("a check that found something is not rendered at all", () => {
    it("neither its label, nor its count, nor its cost sentence is in the section", () => {
      const html = render(MIXED);
      for (const gone of [
        "Broken links and leftover app text",
        "6 issues",
        "6 pieces of leftover app text.",
        "Shopper checks.",
        "Leftover scripts and styles",
        "12 issues",
        "12 extra requests",
        "/app/scans/scan-1",
        "issue",
      ]) {
        expect(html, `"${gone}" must not be rendered`).not.toContain(gone);
      }
      // Every digit left in the section is a theme fact (the version, the library).
      const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");
      expect(text.match(/\d+/g)).toEqual(["15", "2", "0", "2", "0", "3", "20"]);
    });

    it("malicious code with findings is not rendered here either", () => {
      const html = render([
        row({
          key: "malicious",
          label: "Known malicious code",
          status: "issues",
          statusLabel: "1 issue",
          count: 1,
          detail: "1 piece of code from a known malicious source is in your theme.",
          href: "/app/scans/scan-1",
        }),
        TRACKING,
        THEME_OS2,
      ]);
      expect(html).not.toMatch(/malicious/i);
      expect(html).not.toContain("1 issue");
      expect(cleanLine(html)).toBe("Tracking still running");
    });
  });

  it("the names and the theme line are 14px primary; reasons and labels stay subdued", () => {
    /** The inline style of the element whose text is exactly `text`. */
    const styleOf = (html: string, text: string) =>
      html.match(
        new RegExp(`<d[ivt]+ style="([^"]*)">${esc(text).replace(/[.()]/g, "\\$&")}</d[ivt]+>`),
      )?.[1];
    const PRIMARY = /font-size:14px;color:#202223/;
    const SUBDUED = /color:#6d7175;font-size:13px/;

    const html = render(MIXED);
    expect(styleOf(html, "Dawn 15.2.0 by Shopify · Online Store 2.0")).toMatch(PRIMARY);
    expect(
      styleOf(html, "Known malicious code, Tracking still running, Store data left behind"),
    ).toMatch(PRIMARY);
    expect(styleOf(html, "Liquid errors on your homepage")).toMatch(PRIMARY);
    expect(styleOf(html, NOT_RUN)).toMatch(SUBDUED);
    expect(styleOf(html, PLAN_GAP)).toMatch(SUBDUED);
    expect(styleOf(html, "Your store has 3 themes. Shopify allows 20 (more on Plus).")).toMatch(
      SUBDUED,
    );
    for (const label of ["Theme", "Clean", "Not fully checked"]) {
      expect(styleOf(html, label), label).toMatch(SUBDUED);
    }
  });

  it("the label column cannot overflow a narrow screen: the groups wrap, nothing is fixed wide", () => {
    const html = render(MIXED);
    // Each group is a wrapping flex row; the content may shrink to nothing.
    expect(html.match(/display:flex;flex-wrap:wrap/g)).toHaveLength(3);
    expect(html.match(/<dd style="[^"]*min-width:0[^"]*"/g)).toHaveLength(3);
    // No fixed width anywhere, and the only fixed basis is the short label column.
    expect(html).not.toMatch(/[; "]width:\d|min-width:[1-9]|white-space:nowrap/);
    const bases = [...html.matchAll(/flex:\d \d (\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.max(...bases)).toBeLessThanOrEqual(240);
    // Long text can break inside the content column.
    expect(html).toContain("word-break:break-word");
  });

  it("escapes theme-controlled text (a theme name is not markup)", () => {
    const html = render([
      row({
        key: "theme",
        label: "Theme type and version",
        statusLabel: "Online Store 2.0",
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
