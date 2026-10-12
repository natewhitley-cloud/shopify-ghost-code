/**
 * Tests for app/components/ThemeHealthChecklist.tsx (gc-i6du): the section the
 * merchant sees on Home (a verdict, a chip per check, why some checks did not
 * run, the theme facts), and groupHealthRows, which decides what goes where.
 * Static render; no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FindingType } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, it, expect } from "vitest";

import {
  THEME_HEALTH_HEADING,
  THEME_HEALTH_INTRO,
  ThemeHealthChecklist,
} from "../../app/components/ThemeHealthChecklist";
import {
  buildThemeHealthChecklist,
  groupHealthRows,
  HEALTH_CATEGORIES,
  maliciousHealthRow,
} from "../../app/lib/theme-health";
import type { HealthRow, ThemeHealthInput } from "../../app/lib/theme-health";
import {
  BG_BADGE_SUCCESS,
  COLOR_CRITICAL,
  COLOR_SUCCESS,
  COLOR_WARNING,
  SUCCESS_TEXT_STRONG,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  WARN_BD,
  WARN_BG,
  WARN_TEXT_STRONG,
} from "../../app/styles/shared";
import {
  ACTION_ACCENT,
  actionOf,
  BODY,
  chipLines,
  chipsOf,
  esc,
  greenLabels,
  HIDDEN,
  OK_CHIP,
  PRIMARY,
  SUBDUED,
  themeLines,
  themeText,
  verdictOf,
  WARN_CHIP,
} from "../test-utils/theme-health-html";

function render(rows?: HealthRow[], malicious?: HealthRow | null): string {
  const Stub = createRoutesStub([
    { path: "/app", Component: () => <ThemeHealthChecklist rows={rows} malicious={malicious} /> },
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

const UNREACHABLE =
  "We couldn't read your storefront homepage, for example because it has a password. Remove the password, then run a new scan.";
const NOT_RUN = "Not checked on your last scan. Run a new scan.";
const PLAN_GAP = "Old checkout code is checked on Standard and Professional.";
const VINTAGE =
  "Debut 17.14.0 by Shopify is a vintage theme, not Online Store 2.0. It can't use app blocks, so an app that adds something to a page has to write its code into your theme files, and that code stays there when you remove the app. App embeds still work on it.";

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
const MALICIOUS_DETAIL =
  "2 pieces of code from a known malicious source are in your theme. It can steal shopper data or send your customers to other sites.";
const MALICIOUS_ISSUES = row({
  key: "malicious",
  label: "Known malicious code",
  checks: "Malicious checks.",
  status: "issues",
  statusLabel: "2 issues",
  count: 2,
  detail: MALICIOUS_DETAIL,
  href: "/app/scans/scan-1",
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
    // Malicious code is clean here, so it is not the critical line.
    expect(groups.malicious).toBeNull();
  });

  it("no rows: every group is empty", () => {
    expect(groupHealthRows([])).toEqual({
      theme: null,
      unpublished: null,
      clean: [],
      gaps: [],
      hasPartial: false,
      malicious: null,
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

  it("issues rows (the lanes' duplicates) are in no group, except malicious code", () => {
    const rows = HEALTH_CATEGORIES.map((c) =>
      row({ key: c.key, label: c.label, status: "issues", statusLabel: "2 issues", count: 2 }),
    );
    expect(groupHealthRows(rows)).toEqual({
      theme: null,
      unpublished: null,
      clean: [],
      gaps: [],
      hasPartial: false,
      malicious: rows.find((r) => r.key === "malicious"),
    });
    // Without the malicious row, a set of issues rows is in no group at all.
    expect(groupHealthRows(rows.filter((r) => r.key !== "malicious"))).toEqual({
      theme: null,
      unpublished: null,
      clean: [],
      gaps: [],
      hasPartial: false,
      malicious: null,
    });
  });

  it("malicious is set ONLY for the malicious row with status issues", () => {
    expect(groupHealthRows([MALICIOUS_ISSUES, TRACKING]).malicious).toBe(MALICIOUS_ISSUES);
    // It is not also clean or a gap.
    expect(groupHealthRows([MALICIOUS_ISSUES, TRACKING]).clean).toEqual([TRACKING]);
    expect(groupHealthRows([MALICIOUS_ISSUES, TRACKING]).gaps).toEqual([]);
    for (const status of ["clean", "partial", "not_checked", "info"] as const) {
      expect(groupHealthRows([{ ...MALICIOUS_ISSUES, status }]).malicious, status).toBeNull();
    }
    // Any other category with issues is never the critical line.
    for (const c of HEALTH_CATEGORIES.filter((c) => c.key !== "malicious")) {
      const other = row({ key: c.key, label: c.label, status: "issues", statusLabel: "1 issue" });
      expect(groupHealthRows([other]).malicious, c.key).toBeNull();
    }
    // Nor the theme or unpublished rows.
    expect(groupHealthRows([THEME_VINTAGE, { ...UNPUBLISHED, status: "issues" }]).malicious).toBe(
      null,
    );
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

const UNPUBLISHED_TEXT = "Your store has 3 themes. Shopify allows 20 (more on Plus).";

describe("ThemeHealthChecklist", () => {
  it("renders nothing for no rows (and for missing loader data)", () => {
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("renders nothing when there is nothing to say (only checks that found something)", () => {
    expect(render([SHOPPER_ISSUES, SCRIPTS_ISSUES])).toBe("");
    // A theme row and an unpublished row with nothing to say add nothing either.
    expect(
      render([
        SHOPPER_ISSUES,
        { ...THEME_VINTAGE, detail: null },
        { ...UNPUBLISHED, detail: null },
      ]),
    ).toBe("");
  });

  it("is a labelled region with a real heading and an intro, and is not a live region", () => {
    const html = render(MIXED);
    expect(html).toContain('<section aria-labelledby="theme-health-heading"');
    expect(html).toMatch(
      new RegExp(`<h2 id="theme-health-heading"[^>]*>${THEME_HEALTH_HEADING}</h2>`),
    );
    expect(html.match(/<h2/g)).toHaveLength(1);
    expect(THEME_HEALTH_INTRO).toBe("What your last scan checked, beyond the findings above.");
    expect(html).toContain(THEME_HEALTH_INTRO);
    // Not a live region: Home polls every 3s while a scan runs.
    expect(html).not.toMatch(/aria-live|role="status"|role="alert"/);
    // The old description list is gone.
    expect(html).not.toMatch(/<dl|<dt|<dd/);
  });

  it("reads top to bottom: intro, verdict, chips, action box, theme line", () => {
    const html = render(MIXED);
    const order = [
      html.indexOf(THEME_HEALTH_INTRO),
      html.indexOf(esc("Nothing malicious found. Some checks couldn't run.")),
      html.indexOf("<ul"),
      html.indexOf(ACTION_ACCENT),
      html.indexOf("Dawn 15.2.0 by Shopify"),
    ];
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("has no badge, link, button or fold when nothing malicious was found", () => {
    const html = render(MIXED);
    expect(html).not.toMatch(/<s-badge|<a |<button|<s-button|<details|<summary|<h3/);
    expect(html).not.toContain("View findings");
  });

  describe("the verdict line", () => {
    it("is one sentence after a decorative dot", () => {
      const html = render(MIXED);
      expect(html.match(/<p /g)).toHaveLength(2); // the intro and the verdict
      expect(html).toMatch(
        /<p style="[^"]*font-size:15px;font-weight:600[^"]*"><span aria-hidden="true" style="[^"]*border-radius:5px[^"]*"><\/span><span[^>]*>[^<]+<\/span><\/p>/,
      );
      // The dot has no text of its own: the sentence carries the meaning.
      expect(verdictOf(html)!.text.length).toBeGreaterThan(0);
    });

    it("malicious clean, a check not run: amber, nothing malicious found, some couldn't run", () => {
      expect(verdictOf(render(MIXED))).toEqual({
        tone: "warn",
        text: "Nothing malicious found. Some checks couldn't run.",
      });
    });

    it("malicious clean, every gap partial: amber, 'only partly ran'", () => {
      expect(verdictOf(render([MALICIOUS, SNIPPETS_PARTIAL, TRACKING]))).toEqual({
        tone: "warn",
        text: "Nothing malicious found. Some checks only partly ran.",
      });
    });

    it("malicious clean and no gaps: green, 'Nothing malicious found.'", () => {
      expect(verdictOf(render([MALICIOUS, TRACKING, SHOPPER_ISSUES, THEME_OS2]))).toEqual({
        tone: "ok",
        text: "Nothing malicious found.",
      });
    });

    // THE false-all-clear guard, as rendered.
    it.each(["not_checked", "partial"] as const)(
      "malicious %s: amber, names the malicious check, never says nothing malicious was found",
      (status) => {
        const html = render([
          { ...MALICIOUS, status, statusLabel: "x", detail: NOT_RUN },
          TRACKING,
          STORE_DATA,
          THEME_OS2,
        ]);
        expect(verdictOf(html)).toEqual({
          tone: "warn",
          text: "Some checks couldn't run, including the check for malicious code.",
        });
        expect(html).not.toMatch(/nothing malicious/i);
        expect(html).not.toContain(`background:${COLOR_SUCCESS}`);
      },
    );

    it("no malicious row at all (legacy rows): amber, names the malicious check", () => {
      const html = render([TRACKING, STORE_DATA, THEME_OS2]);
      expect(verdictOf(html)).toEqual({
        tone: "warn",
        text: "Some checks couldn't run, including the check for malicious code.",
      });
      expect(html).not.toMatch(/nothing malicious/i);
    });

    it("never has a digit, a count or a score, whatever the rows", () => {
      for (const rows of [
        MIXED,
        [MALICIOUS, TRACKING],
        [MALICIOUS, SNIPPETS_PARTIAL],
        [LIQUID_NOT_CHECKED],
        HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label })),
      ]) {
        const { text } = verdictOf(render(rows))!;
        expect(text).not.toMatch(/\d|%|\bscore\b|\bgrade\b|\bof\b/i);
      }
    });
  });

  describe("the chips", () => {
    it("one of every status: the exact chips, tones and hidden prefixes, in category order", () => {
      const html = render(MIXED);
      expect(chipsOf(html)).toEqual([
        { tone: "ok", glyph: "✓", prefix: "Clean: ", label: "Known malicious code" },
        {
          tone: "warn",
          glyph: "!",
          prefix: "Not checked: ",
          label: "Liquid errors on your homepage",
        },
        {
          tone: "warn",
          glyph: "!",
          prefix: "Partly checked: ",
          label: "Leftover snippets and sections",
        },
        { tone: "ok", glyph: "✓", prefix: "Clean: ", label: "Tracking still running" },
        { tone: "ok", glyph: "✓", prefix: "Clean: ", label: "Store data left behind" },
      ]);
      // A real list, so the chips are announced as items.
      expect(html.match(/<ul/g)).toHaveLength(1);
    });

    it("the tick and the ! are hidden from assistive tech; the prefix says it in words", () => {
      const html = render(MIXED);
      expect(html.match(/<li [^>]*><span aria-hidden="true"/g)).toHaveLength(5);
      // Read aloud: the prefix, then the name.
      const spoken = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) =>
        m[1].replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, ""),
      );
      expect(spoken).toEqual([
        "Clean: Known malicious code",
        "Not checked: Liquid errors on your homepage",
        "Partly checked: Leftover snippets and sections",
        "Clean: Tracking still running",
        "Clean: Store data left behind",
      ]);
    });

    it("a check that found something has no chip (the lanes above already show it)", () => {
      const labels = chipsOf(render(MIXED)).map((c) => c.label);
      expect(labels).not.toContain("Broken links and leftover app text");
      expect(labels).not.toContain("Leftover scripts and styles");
    });

    // THE false-Clean guard: only a status of exactly "clean" is ever green.
    it.each(["partial", "not_checked"] as const)(
      "a %s row is an amber chip, never green and never called clean, in any category",
      (status) => {
        const html = render(
          HEALTH_CATEGORIES.map((c) =>
            row({ key: c.key, label: c.label, status, statusLabel: "x", detail: "Why." }),
          ),
        );
        const chips = chipsOf(html);
        expect(chips).toHaveLength(9);
        for (const chip of chips) {
          expect(chip.tone, chip.label).toBe("warn");
          expect(chip.glyph, chip.label).toBe("!");
          expect(chip.prefix, chip.label).toBe(
            status === "partial" ? "Partly checked: " : "Not checked: ",
          );
        }
        expect(html).not.toContain(BG_BADGE_SUCCESS);
        expect(html).not.toContain(SUCCESS_TEXT_STRONG);
        expect(html).not.toContain("✓");
        expect(html).not.toMatch(/clean/i);
      },
    );

    it.each(["issues", "info"] as const)("a %s row has no chip at all", (status) => {
      const html = render([
        TRACKING,
        row({ key: "seo-ai", label: "SEO and AI tags", status, statusLabel: "x", detail: "Why." }),
      ]);
      expect(chipLines(html)).toEqual(["ok Clean: Tracking still running"]);
      expect(html).not.toContain("SEO and AI tags");
    });

    it("all nine checks clean: nine green chips in category order", () => {
      const html = render([
        ...HEALTH_CATEGORIES.map((c) => row({ key: c.key, label: c.label })),
        THEME_OS2,
        UNPUBLISHED,
      ]);
      expect(chipLines(html)).toEqual(HEALTH_CATEGORIES.map((c) => `ok Clean: ${c.label}`));
      expect(actionOf(html)).toBeNull();
    });

    it("keeps the category order whatever order the rows arrive in", () => {
      const html = render([STORE_DATA, SNIPPETS_PARTIAL, TRACKING, LIQUID_NOT_CHECKED, MALICIOUS]);
      expect(chipsOf(html).map((c) => c.label)).toEqual([
        "Known malicious code",
        "Liquid errors on your homepage",
        "Leftover snippets and sections",
        "Tracking still running",
        "Store data left behind",
      ]);
    });

    it("the theme and unpublished rows are never chips, even though an os2 theme row is 'clean'", () => {
      const html = render([TRACKING, THEME_OS2, UNPUBLISHED]);
      expect(chipLines(html)).toEqual(["ok Clean: Tracking still running"]);
    });

    it("shows names only: no count, no per-check description, no row badge text", () => {
      const html = render(MIXED);
      for (const chip of chipsOf(html)) expect(chip.label).not.toMatch(/\d/);
      for (const checks of ["Malicious checks.", "Tracking checks.", "Store data checks."]) {
        expect(html).not.toContain(checks);
      }
      // "None found" (a partial row's own label) reads as clean: never shown.
      expect(html).not.toContain("None found");
      // A clean row's detail (the builder never sets one) is not shown either.
      expect(render([row({ detail: "Not a real builder output." })])).not.toContain(
        "Not a real builder output.",
      );
    });

    it("no list is rendered when there is no chip", () => {
      const html = render([SHOPPER_ISSUES, THEME_OS2]);
      expect(html).not.toContain("<ul");
      expect(chipsOf(html)).toEqual([]);
    });
  });

  describe("the action box", () => {
    const DEADLINE_PARTIAL = row({
      key: "script-tag-deadline",
      label: "Script tag deadline",
      status: "partial",
      statusLabel: "None found",
      detail: UNREACHABLE,
    });
    const LIQUID_UNREACHABLE = { ...LIQUID_NOT_CHECKED, detail: UNREACHABLE };

    it("two checks that share a reason: the reason once, under both names", () => {
      const html = render([MALICIOUS, LIQUID_UNREACHABLE, TRACKING, DEADLINE_PARTIAL, THEME_OS2]);
      expect(actionOf(html)!.entries).toEqual([
        { names: "Liquid errors on your homepage, Script tag deadline", reason: UNREACHABLE },
      ]);
      expect(html.split(esc(UNREACHABLE))).toHaveLength(2);
    });

    it("two different reasons: two entries in the one box, in row order", () => {
      const html = render(MIXED);
      expect(actionOf(html)!.entries).toEqual([
        { names: "Liquid errors on your homepage", reason: NOT_RUN },
        { names: "Leftover snippets and sections", reason: PLAN_GAP },
      ]);
      expect(html.split(ACTION_ACCENT)).toHaveLength(2);
    });

    it("a mix: shared reasons group, the others stand alone", () => {
      const html = render([
        LIQUID_UNREACHABLE,
        SNIPPETS_PARTIAL,
        row({ key: "seo-ai", label: "SEO and AI tags", status: "not_checked", detail: NOT_RUN }),
        DEADLINE_PARTIAL,
      ]);
      expect(actionOf(html)!.entries).toEqual([
        { names: "Liquid errors on your homepage, Script tag deadline", reason: UNREACHABLE },
        { names: "Leftover snippets and sections", reason: PLAN_GAP },
        { names: "SEO and AI tags", reason: NOT_RUN },
      ]);
    });

    it("the names are bold primary text; the reason is subdued, under them", () => {
      const { box } = actionOf(render(MIXED))!;
      expect(box).toMatch(
        new RegExp(
          `<strong style="[^"]*${PRIMARY}[^"]*display:block;font-weight:600">Liquid errors on your homepage</strong><span style="${SUBDUED}[^"]*">${NOT_RUN.replace(/\./g, "\\.")}</span>`,
        ),
      );
    });

    it("is amber with a 5px left accent", () => {
      const { box } = actionOf(render(MIXED))!;
      expect(box).toContain(`border:1px solid ${WARN_BD};border-left:5px solid ${COLOR_WARNING}`);
      expect(box).toContain(`background:${WARN_BG}`);
    });

    it("is absent when there is no gap", () => {
      expect(actionOf(render([MALICIOUS, TRACKING, SHOPPER_ISSUES, THEME_OS2]))).toBeNull();
      expect(actionOf(render([THEME_OS2, UNPUBLISHED]))).toBeNull();
    });

    it("has no button and no link: the sentence is the action, and there is no upgrade ask", () => {
      for (const rows of [
        MIXED,
        [SNIPPETS_PARTIAL],
        [{ ...LIQUID_NOT_CHECKED, detail: "Checked in full on Standard and Professional." }],
      ]) {
        const html = render(rows);
        const { box } = actionOf(html)!;
        expect(box).not.toMatch(/<s-button|<button|<a |href=|<s-link|role="button"/);
        expect(html).not.toMatch(/<s-button|<button|<a |pricing_plans|Upgrade|free trial/i);
      }
    });

    it("a gap with no reason still names the check", () => {
      const html = render([{ ...LIQUID_NOT_CHECKED, detail: null }]);
      expect(actionOf(html)!.entries).toEqual([
        { names: "Liquid errors on your homepage", reason: null },
      ]);
    });
  });

  describe("the theme line", () => {
    it("an Online Store 2.0 theme: the title, a middle dot, then the type, subdued", () => {
      const html = render([THEME_OS2]);
      expect(themeLines(html)).toEqual([
        { text: "Dawn 15.2.0 by Shopify · Online Store 2.0", style: expect.any(String) },
      ]);
      expect(themeLines(html)[0].style.startsWith(SUBDUED)).toBe(true);
    });

    it("with the unpublished row: one line, the library fact after another middle dot", () => {
      const html = render([TRACKING, THEME_OS2, UNPUBLISHED]);
      expect(themeText(html)).toEqual([
        `Dawn 15.2.0 by Shopify · Online Store 2.0 · ${UNPUBLISHED_TEXT}`,
      ]);
      expect(themeLines(html)[0].style.startsWith(SUBDUED)).toBe(true);
      // Its row label and badge text are not shown: the sentence says it all.
      expect(html).not.toContain("Unpublished themes");
      expect(html).not.toContain("2 unpublished");
    });

    it("a theme whose type was not detected: the title, then 'Type not detected'", () => {
      expect(themeText(render([THEME_INFO]))).toEqual(["Dawn - live · Type not detected"]);
      expect(themeText(render([THEME_INFO, UNPUBLISHED]))).toEqual([
        `Dawn - live · Type not detected · ${UNPUBLISHED_TEXT}`,
      ]);
    });

    it("a vintage theme: its sentence as it is, in primary ink (a fact the lanes do not have)", () => {
      const html = render([THEME_VINTAGE, SHOPPER_ISSUES]);
      const lines = themeLines(html);
      expect(lines.map((l) => l.text)).toEqual([VINTAGE]);
      expect(lines[0].style.startsWith(PRIMARY)).toBe(true);
      // The sentence already says "vintage theme": the status label is not appended.
      expect(lines[0].text).not.toContain("·");
      expect(html.match(/vintage theme/gi)).toHaveLength(1);
    });

    it("a vintage theme with the unpublished row: the library fact on its own subdued line", () => {
      const lines = themeLines(render([THEME_VINTAGE, UNPUBLISHED]));
      expect(lines.map((l) => l.text)).toEqual([VINTAGE, UNPUBLISHED_TEXT]);
      expect(lines[0].style.startsWith(PRIMARY)).toBe(true);
      expect(lines[1].style.startsWith(SUBDUED)).toBe(true);
    });

    it("a theme that was not checked: its 'Run a new scan' line, subdued", () => {
      const html = render([THEME_NOT_CHECKED]);
      const lines = themeLines(html);
      expect(lines.map((l) => l.text)).toEqual([
        "Run a new scan to see your theme's name, version and type.",
      ]);
      expect(lines[0].style.startsWith(SUBDUED)).toBe(true);
      expect(html).not.toContain("·");
      expect(html).not.toContain("Not checked");
      expect(themeText(render([THEME_NOT_CHECKED, UNPUBLISHED]))).toEqual([
        "Run a new scan to see your theme's name, version and type.",
        UNPUBLISHED_TEXT,
      ]);
    });

    it("shows with only the unpublished row", () => {
      expect(themeText(render([UNPUBLISHED]))).toEqual([UNPUBLISHED_TEXT]);
    });

    it("a theme with no title still shows its type; with nothing to say there is no line", () => {
      expect(themeLines(render([TRACKING, { ...THEME_OS2, detail: null }]))).toEqual([
        { text: "Online Store 2.0", style: expect.any(String) },
      ]);
      expect(themeLines(render([TRACKING]))).toEqual([]);
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
  });

  // Security findings are never hidden: Home has no malicious-code alert of its
  // own, so this is the one check with findings that the section still shows.
  describe("known malicious code with findings", () => {
    /** The critical line: everything between the intro and the body (or the section end). */
    const criticalLine = (html: string) =>
      html.match(
        new RegExp(
          `</p>(<div[\\s\\S]*?</div></div>)(?:${BODY.replace(/[()]/g, "\\$&")}|</section>)`,
        ),
      )?.[1] ?? null;

    const WITH_OTHERS = [
      MALICIOUS_ISSUES,
      SHOPPER_ISSUES,
      SCRIPTS_ISSUES,
      LIQUID_NOT_CHECKED,
      TRACKING,
      THEME_OS2,
    ];

    it("is a critical line with its count, label, cost sentence and a link to the findings", () => {
      const html = render(WITH_OTHERS);
      const line = criticalLine(html)!;
      expect(line).toBeTruthy();
      expect(line).toContain('<s-badge tone="critical">2 issues</s-badge>');
      expect(line).toMatch(
        /<strong style="[^"]*color:#202223[^"]*font-weight:600[^"]*">Known malicious code<\/strong>/,
      );
      expect(line).toContain(MALICIOUS_DETAIL);
      expect(line).toMatch(
        /<a aria-label="View findings: Known malicious code" href="\/app\/scans\/scan-1"[^>]*>View findings<\/a>/,
      );
      // One badge, one link, in the whole section.
      expect(html.match(/<s-badge/g)).toHaveLength(1);
      expect(html.match(/<a /g)).toHaveLength(1);
    });

    it("is in critical colours with a 5px left accent", () => {
      const line = criticalLine(render(WITH_OTHERS))!;
      expect(line).toMatch(
        new RegExp(`^<div style="[^"]*border-left:5px solid ${COLOR_CRITICAL}[^"]*">`),
      );
    });

    it("the link's accessible name contains its visible text", () => {
      const html = render(WITH_OTHERS);
      const [, name, text] = html.match(/<a aria-label="([^"]*)"[^>]*>([^<]*)<\/a>/)!;
      expect(text).toBe("View findings");
      expect(name).toContain(text);
    });

    it("IS the verdict: no verdict line, no dot, and never 'nothing malicious found'", () => {
      for (const rows of [
        WITH_OTHERS,
        [MALICIOUS_ISSUES, TRACKING, STORE_DATA, THEME_OS2],
        [MALICIOUS_ISSUES],
      ]) {
        const html = render(rows);
        expect(verdictOf(html)).toBeNull();
        expect(html.match(/<p /g)).toHaveLength(1); // the intro only
        expect(html).not.toMatch(/nothing malicious|couldn&#x27;t run, including/i);
        expect(html).not.toContain("border-radius:5px");
      }
    });

    it("sits at the top of the section, above the chips, the action box and the theme line", () => {
      const html = render(WITH_OTHERS);
      expect(html.indexOf("Known malicious code")).toBeGreaterThan(
        html.indexOf(THEME_HEALTH_INTRO),
      );
      expect(html.indexOf("Known malicious code")).toBeLessThan(html.indexOf("<ul"));
      expect(chipLines(html)).toEqual([
        "warn Not checked: Liquid errors on your homepage",
        "ok Clean: Tracking still running",
      ]);
      expect(actionOf(html)!.entries).toEqual([
        { names: "Liquid errors on your homepage", reason: NOT_RUN },
      ]);
      expect(themeText(html)).toEqual(["Dawn 15.2.0 by Shopify · Online Store 2.0"]);
    });

    it("malicious code is not a chip, and the other checks that found something stay absent", () => {
      const html = render(WITH_OTHERS);
      for (const gone of [
        "Broken links and leftover app text",
        "6 issues",
        "6 pieces of leftover app text.",
        "Leftover scripts and styles",
        "12 issues",
        "12 extra requests",
        "?type=GHOST_SCRIPT",
      ]) {
        expect(html, `"${gone}" must not be rendered`).not.toContain(gone);
      }
      expect(chipsOf(html).map((c) => c.label)).not.toContain("Known malicious code");
      expect(html.match(/Known malicious code/g)).toHaveLength(2); // label + link aria-label
    });

    it("the section still renders when it is the only thing to show", () => {
      const html = render([MALICIOUS_ISSUES, SHOPPER_ISSUES, SCRIPTS_ISSUES]);
      expect(html).toContain('<section aria-labelledby="theme-health-heading"');
      expect(html).toContain(THEME_HEALTH_HEADING);
      expect(criticalLine(html)).toContain('<s-badge tone="critical">2 issues</s-badge>');
      expect(html).toContain("Known malicious code");
      // No empty body: no list, no box, no theme line.
      expect(html).not.toContain(BODY);
      expect(html).not.toContain("<ul");
      expect(actionOf(html)).toBeNull();
      expect(html).not.toContain("6 issues");
      // On its own row too.
      expect(render([MALICIOUS_ISSUES])).toContain("Known malicious code");
    });

    it("shows no link without an href and no sentence without a detail", () => {
      const html = render([{ ...MALICIOUS_ISSUES, href: null, detail: null }]);
      expect(html).toContain('<s-badge tone="critical">2 issues</s-badge>');
      expect(html).toContain("Known malicious code");
      expect(html).not.toContain("<a");
      expect(html).not.toContain("View findings");
    });

    it("clean malicious code is a green chip only: no critical line, badge or link", () => {
      const html = render([MALICIOUS, TRACKING, THEME_OS2]);
      expect(chipLines(html)).toEqual([
        "ok Clean: Known malicious code",
        "ok Clean: Tracking still running",
      ]);
      expect(html.match(/Known malicious code/g)).toHaveLength(1);
      expect(html).not.toContain("<s-badge");
      expect(html).not.toContain("<a");
      expect(html).not.toContain("View findings");
      expect(html).not.toContain(COLOR_CRITICAL);
    });

    it.each([
      ["partial", "Partly checked: "],
      ["not_checked", "Not checked: "],
    ] as const)(
      "malicious code that was %s is an amber chip, not the critical line",
      (status, prefix) => {
        const html = render([{ ...MALICIOUS_ISSUES, status, statusLabel: "x", href: null }]);
        expect(html).not.toContain("<s-badge");
        expect(html).not.toContain("View findings");
        expect(chipsOf(html)).toEqual([
          { tone: "warn", glyph: "!", prefix, label: "Known malicious code" },
        ]);
      },
    );

    it("cannot overflow a narrow screen and has no em dash", () => {
      const html = render(WITH_OTHERS);
      const line = criticalLine(html)!;
      expect(line).toMatch(/^<div style="[^"]*"><div style="display:flex;flex-wrap:wrap/);
      expect(line).not.toMatch(/[; "]width:\d|min-width:[1-9]|white-space:nowrap/);
      expect(line).not.toContain("\u2014");
    });
  });

  // The real builder's rows, rendered: what a merchant in each state sees.
  describe("end to end with the real buildThemeHealthChecklist", () => {
    const ALL_LIVE = new Set<string>(Object.values(FindingType));
    const FULL_COVERAGE = {
      skippedCategories: [],
      cappedCategories: [],
      unreachableCategories: [],
      liveTypes: ALL_LIVE,
      liveNow: ALL_LIVE,
      planWithheld: [],
      isPublishedTheme: true,
    };
    const THEMES = [
      { id: "1", name: "Dawn - live", role: "MAIN", lastScanFindingCount: null },
      { id: "2", name: "Dawn - copy", role: "UNPUBLISHED", lastScanFindingCount: null },
      { id: "3", name: "Old Debut", role: "UNPUBLISHED", lastScanFindingCount: null },
    ];
    const build = (overrides: Partial<ThemeHealthInput> = {}) =>
      buildThemeHealthChecklist({
        scanId: "scan-1",
        typeCounts: {},
        coverage: FULL_COVERAGE,
        fullList: true,
        themeInfo: { name: "Dawn", version: "15.2.0", author: "Shopify", architecture: "os2" },
        scanThemeName: "Dawn - live",
        themes: THEMES,
        scriptTagsStopped: false,
        ...overrides,
      });
    const ALL_LABELS = HEALTH_CATEGORIES.map((c) => c.label);

    it("full coverage, zero findings: green verdict, every chip green, no action box", () => {
      const html = render(build());
      expect(verdictOf(html)).toEqual({ tone: "ok", text: "Nothing malicious found." });
      expect(chipLines(html)).toEqual(ALL_LABELS.map((label) => `ok Clean: ${label}`));
      expect(actionOf(html)).toBeNull();
      expect(html).not.toContain(WARN_BD);
      expect(themeText(html)).toEqual([
        `Dawn 15.2.0 by Shopify · Online Store 2.0 · ${UNPUBLISHED_TEXT}`,
      ]);
    });

    it("unreachable storefront: amber verdict; both storefront checks amber under ONE reason, never green", () => {
      const html = render(
        build({
          typeCounts: { GHOST_TEXT: 6, GHOST_SCRIPT: 12, GHOST_SNIPPET: 3 },
          coverage: {
            ...FULL_COVERAGE,
            unreachableCategories: ["SCRIPT_TAG_SUNSET", "LIQUID_ERROR_RENDERED"],
          },
        }),
      );
      expect(verdictOf(html)).toEqual({
        tone: "warn",
        text: "Nothing malicious found. Some checks couldn't run.",
      });
      expect(chipLines(html)).toEqual([
        "ok Clean: Known malicious code",
        "warn Not checked: Liquid errors on your homepage",
        "ok Clean: SEO and AI tags",
        "ok Clean: Tracking still running",
        "ok Clean: Store data left behind",
        "warn Partly checked: Script tag deadline",
      ]);
      expect(greenLabels(html)).not.toContain("Liquid errors on your homepage");
      expect(greenLabels(html)).not.toContain("Script tag deadline");
      // The owner's screenshot showed this sentence twice: now it is there once.
      expect(actionOf(html)!.entries).toEqual([
        { names: "Liquid errors on your homepage, Script tag deadline", reason: UNREACHABLE },
      ]);
      expect(html.split(esc(UNREACHABLE))).toHaveLength(2);
      // The three checks with findings are the lanes' job.
      for (const gone of [
        "Broken links and leftover app text",
        "Leftover scripts and styles",
        "Leftover snippets and sections",
        "issue",
      ]) {
        expect(html, gone).not.toContain(gone);
      }
    });

    it("a legacy scan (no recorded coverage): amber verdict naming the malicious check, no green chip", () => {
      const html = render(
        build({ coverage: { ...FULL_COVERAGE, liveTypes: null }, themeInfo: null }),
      );
      expect(verdictOf(html)).toEqual({
        tone: "warn",
        text: "Some checks couldn't run, including the check for malicious code.",
      });
      expect(html).not.toMatch(/nothing malicious/i);
      expect(chipLines(html)).toEqual(ALL_LABELS.map((label) => `warn Not checked: ${label}`));
      expect(greenLabels(html)).toEqual([]);
      expect(html).not.toContain(BG_BADGE_SUCCESS);
      expect(html).not.toContain(COLOR_SUCCESS);
      expect(html).not.toMatch(/clean/i);
      // Nine checks, one reason, said once.
      expect(actionOf(html)!.entries).toEqual([{ names: ALL_LABELS.join(", "), reason: NOT_RUN }]);
      expect(themeText(html)).toEqual([
        "Run a new scan to see your theme's name, version and type.",
        UNPUBLISHED_TEXT,
      ]);
    });

    it("Free plan gaps: 'only partly ran', and each plan-gated check named with its own sentence", () => {
      const html = render(
        build({
          fullList: false,
          coverage: { ...FULL_COVERAGE, planWithheld: ["DANGLING_REFERENCE", "CHECKOUT_SUNSET"] },
        }),
      );
      expect(verdictOf(html)).toEqual({
        tone: "warn",
        text: "Nothing malicious found. Some checks only partly ran.",
      });
      expect(chipLines(html)).toEqual(
        ALL_LABELS.map((label) =>
          label === "Broken links and leftover app text" ||
          label === "Leftover snippets and sections"
            ? `warn Partly checked: ${label}`
            : `ok Clean: ${label}`,
        ),
      );
      expect(actionOf(html)!.entries).toEqual([
        {
          names: "Broken links and leftover app text",
          reason: "Broken links are checked on Standard and Professional.",
        },
        {
          names: "Leftover snippets and sections",
          reason: "Old checkout code is checked on Standard and Professional.",
        },
      ]);
      // Named in plain text: no button, link or upgrade ask.
      expect(html).not.toMatch(/<s-button|<button|<a |pricing_plans|Upgrade|free trial/i);
    });

    it("malicious code found, the other checks clean: the red line, no verdict, malicious not a chip", () => {
      const rows = build({ typeCounts: { MALICIOUS_SCRIPT: 2 } });
      for (const html of [
        render(rows, maliciousHealthRow("scan-1", 2)),
        render(rows),
        // Every malicious finding ignored: the rows say clean, the line says found.
        render(build(), maliciousHealthRow("scan-1", 2)),
      ]) {
        expect(html).toContain('<s-badge tone="critical">2 issues</s-badge>');
        expect(html).toContain(MALICIOUS_DETAIL);
        expect(verdictOf(html)).toBeNull();
        expect(html).not.toMatch(/nothing malicious/i);
        expect(chipLines(html)).toEqual(
          ALL_LABELS.filter((l) => l !== "Known malicious code").map((l) => `ok Clean: ${l}`),
        );
      }
    });

    it("every state: no score, percentage, count of checks, 'x of y' or em dash", () => {
      for (const html of [
        render(build()),
        render(build({ coverage: { ...FULL_COVERAGE, liveTypes: null } })),
        render(build({ coverage: { ...FULL_COVERAGE, planWithheld: ["DANGLING_REFERENCE"] } })),
        render(build({ typeCounts: { MALICIOUS_SCRIPT: 2 } })),
      ]) {
        expect(html).not.toMatch(/%|\bscore\b|\bgrade\b|out of|\b\d+ of \d+\b|\d+ checks?\b/i);
        expect(html).not.toContain("\u2014");
      }
    });
  });

  it("the verdict leads in primary ink; chip text is the strong ink of its tint; reasons and the theme line stay subdued", () => {
    const html = render(MIXED);
    expect(html).toMatch(
      new RegExp(
        `<p style="[^"]*font-size:15px;font-weight:600;line-height:20px;color:${TEXT_PRIMARY}"`,
      ),
    );
    expect(html.split(OK_CHIP)).toHaveLength(4);
    expect(html.split(WARN_CHIP)).toHaveLength(3);
    expect(html).toContain(`<span style="${SUBDUED};word-break:break-word">${NOT_RUN}</span>`);
    expect(html).toContain(`<span style="${SUBDUED};word-break:break-word">${PLAN_GAP}</span>`);
    expect(themeLines(html)[0].style).toBe(`${SUBDUED};word-break:break-word`);
  });

  it("cannot overflow a narrow screen: the chips wrap, every block can shrink, nothing is fixed wide", () => {
    const html = render([...MIXED, { ...MALICIOUS_ISSUES }].reverse());
    expect(render(MIXED)).toMatch(/<ul style="display:flex;flex-wrap:wrap;[^"]*min-width:0"/);
    for (const page of [html, render(MIXED)]) {
      // The body, the chip list, each chip, the verdict sentence, the action
      // box and its entries may all shrink below their content.
      expect(page).toContain(BODY);
      expect(page).toMatch(/<ul style="display:flex;flex-wrap:wrap;[^"]*min-width:0"/);
      for (const [, style] of page.matchAll(/<li style="([^"]*)"/g)) {
        expect(style).toContain("min-width:0");
        expect(style).toContain("word-break:break-word");
      }
      expect(page).toMatch(
        new RegExp(
          `<div style="display:flex;flex-direction:column;[^"]*min-width:0;[^"]*${ACTION_ACCENT}`,
        ),
      );
      // Nothing visible has a fixed width or refuses to wrap. The two
      // exceptions are not layout: the 10px dot and the 1px hidden prefixes.
      const visible = page
        .replace(/<span aria-hidden="true" style="[^"]*border-radius:5px[^"]*"><\/span>/g, "")
        .replace(new RegExp(`<span style="${HIDDEN}[^"]*">[^<]*</span>`, "g"), "");
      expect(visible).not.toMatch(
        /[; "]width:\d|min-width:[1-9]|white-space:nowrap|flex-wrap:nowrap/,
      );
      expect(visible).not.toMatch(/overflow-x|flex:\d \d \d+px/);
      // Long text can break anywhere it has to.
      expect(page.match(/word-break:break-word/g)!.length).toBeGreaterThan(5);
    }
    // The verdict sentence sits beside the dot and wraps inside its own box.
    expect(render(MIXED)).toMatch(
      /<span aria-hidden="true" style="flex:none;[^"]*"><\/span><span style="min-width:0;word-break:break-word">/,
    );
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

  it("chip text meets 4.5:1 on its chip background, and the reason text on the action box", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(contrast(SUCCESS_TEXT_STRONG, BG_BADGE_SUCCESS)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WARN_TEXT_STRONG, WARN_BD)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(TEXT_SUBDUED, WARN_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(TEXT_PRIMARY, WARN_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it("has no score, percentage, 'x of y' or em dash", () => {
    const html = render(MIXED);
    expect(html).not.toMatch(/%|\bscore\b|\bgrade\b|out of|\b\d+ of \d+\b/i);
    expect(html).not.toContain("\u2014");
  });
});

// Reviewer L1 + L3: the malicious line can be passed on its own, built from
// the scan's count, and wins over whatever the rows say.
describe("ThemeHealthChecklist: malicious line passed independently of the rows", () => {
  it("renders the critical line alone when there are no rows", () => {
    const html = render([], MALICIOUS_ISSUES);
    expect(html).toContain('<section aria-labelledby="theme-health-heading"');
    expect(html).toContain('<s-badge tone="critical">2 issues</s-badge>');
    expect(html).toContain(">Known malicious code</strong>");
    expect(html).toContain(MALICIOUS_DETAIL);
    expect(html).toContain('href="/app/scans/scan-1"');
    expect(html).not.toContain(BODY);
    expect(html).not.toContain("<ul");
    expect(verdictOf(html)).toBeNull();
  });

  it("no green malicious chip and no 'nothing malicious' when the rows say clean but the line is passed", () => {
    const html = render([MALICIOUS, TRACKING, THEME_OS2], MALICIOUS_ISSUES);
    expect(html).toContain('<s-badge tone="critical">2 issues</s-badge>');
    expect(chipLines(html)).toEqual(["ok Clean: Tracking still running"]);
    expect(verdictOf(html)).toBeNull();
    expect(html).not.toMatch(/nothing malicious/i);
    expect(html.match(/Known malicious code/g)).toHaveLength(2); // label + link aria-label
  });

  it("null or omitted: nothing changes", () => {
    expect(render([MALICIOUS, THEME_OS2], null)).toBe(render([MALICIOUS, THEME_OS2]));
    expect(render([], null)).toBe("");
  });
});
