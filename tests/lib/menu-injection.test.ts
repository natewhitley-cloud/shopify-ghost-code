/**
 * MENU_INJECTION plumbing (gc-7gjj.1): how the new finding type is classified,
 * ranked, worded and shown. It is a security finding in store data (a menu
 * label or link), so it is never paywalled, has its own section (a Security
 * risk banner), honours ignores, has no consequence lane, is scope-gated
 * (read_online_store_navigation) and is dark behind MENU_INJECTION_LIVE_ENABLED.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { FindingType } from "@prisma/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, it, expect } from "vitest";

import { SecurityRiskBanner } from "../../app/components/SecurityRiskBanner";
import {
  getFindingConfidence,
  isAdminResourceFinding,
  isNeverPaywalledFindingType,
  isOwnSectionFindingType,
  isThemeFileFinding,
} from "../../app/lib/finding-classification";
import { CONSEQUENCE_MAP, laneForType } from "../../app/lib/finding-consequence";
import {
  buildRemovalInstructions,
  getFindingCardCopy,
  getFindingImpact,
  getFindingRemediation,
  MENU_INJECTION_STEPS,
} from "../../app/lib/finding-remediation";
import { getRemovalSafety } from "../../app/lib/finding-safety";
import { FINDING_TYPE_LABELS } from "../../app/lib/finding-type-labels";
import { SKIPPABLE_CATEGORY_INFO, skippedCategoryLabels } from "../../app/lib/optional-scopes";
import {
  countKeptSecurityRisks,
  homeRiskSummaryLine,
  MENU_RISK_GROUP_FACTS,
  MENU_RISK_ITEMS_SHOWN,
  MENU_RISK_TITLE,
  securityRiskAnchorId,
  securityRiskBody,
  securityRiskSourceLabel,
  securityRiskTitle,
  type MenuRisk,
} from "../../app/lib/security-risk";
import {
  groupHealthRows,
  menuHealthRow,
  themeHealthVerdict,
  VERDICT_ADVISORY,
  VERDICT_MENU,
  type HealthCoverageInput,
} from "../../app/lib/theme-health";
import {
  compareFindingImportance,
  findingCostLine,
  securityRank,
  toTopFindingViews,
} from "../../app/lib/top-findings";
import { diffScans, scanDiffOptions } from "../../app/services/scan-differ.server";
import { buildSecurityRisks } from "../../app/services/security-risk.server";
import { isMenuInjectionLive, isSoftLaunchLive } from "../../app/services/soft-launch-flags.server";

const MENU = "MENU_INJECTION" as const;
const ROOT = join(__dirname, "..", "..");

const menuFinding = {
  id: "f-menu",
  findingType: MENU,
  filename: "menus/11/items/22",
  lineNumber: 0,
  codeSnippet: "Main menu > Shop\nLabel: Shop<img src=x onerror=x()>",
  description:
    "A menu item's label contains code that runs when the label is shown. Apps and staff can edit menus; in October 2026 a compromised app used menu labels to hijack checkouts.",
};

describe("classification", () => {
  it("is never paywalled and shown in its own section (a banner), on every plan", () => {
    expect(isNeverPaywalledFindingType(MENU)).toBe(true);
    expect(isOwnSectionFindingType(MENU)).toBe(true);
  });

  it("is an Admin-resource finding (a menu), never a theme file", () => {
    expect(isAdminResourceFinding(MENU)).toBe(true);
    expect(isThemeFileFinding(MENU)).toBe(false);
  });

  it("is a signature match, a security risk, with no lane", () => {
    expect(getFindingConfidence(MENU)).toBe("signature");
    expect(getRemovalSafety(MENU)).toBe("security-risk");
    expect(laneForType(MENU)).toBeNull();
    expect(CONSEQUENCE_MAP[MENU].urgency).toBe("act-now");
  });

  it("has a merchant label and a scope-gated skipped-check label", () => {
    expect(FINDING_TYPE_LABELS[MENU]).toBe("Code in Menu Labels");
    expect(SKIPPABLE_CATEGORY_INFO[MENU]).toEqual({
      label: "Menu labels",
      scopes: ["read_online_store_navigation"],
    });
    expect(skippedCategoryLabels(["GHOST_REDIRECT", MENU])).toEqual([
      "URL redirects",
      "Menu labels",
    ]);
  });
});

describe("ranking (Start here)", () => {
  const row = (id: string, findingType: FindingType, severity: "HIGH" | "LOW" = "HIGH") => ({
    id,
    findingType,
    severity,
    createdAt: new Date("2026-10-27T00:00:00Z"),
  });

  it("ranks below known malicious code and above every non-security finding", () => {
    expect(securityRank(MENU)).toBe(1);
    const rows = [row("g", "GHOST_SCRIPT"), row("m", MENU), row("x", "MALICIOUS_SCRIPT", "LOW")];
    expect([...rows].sort(compareFindingImportance).map((r) => r.id)).toEqual(["x", "m", "g"]);
  });

  it("its Start here row is a security risk with the menu title, location and banner link", () => {
    const [view] = toTopFindingViews(
      "scan-1",
      [{ ...row("f-menu", MENU), filename: menuFinding.filename, lineNumber: 0, appName: null }],
      false,
    );
    expect(view).toMatchObject({
      title: MENU_RISK_TITLE,
      linkLabel: "See what to check",
      securityRisk: true,
      lane: null,
      location: "Menu item",
      href: "/app/scans/scan-1#finding-f-menu",
    });
    expect(view.cost).toBe(findingCostLine(MENU));
    expect(view.cost.length).toBeGreaterThan(0);
  });
});

describe("copy and remediation", () => {
  it("the card is a security card: steps, no removal badge, no code editor", () => {
    const copy = getFindingCardCopy(MENU, menuFinding.filename);
    expect(copy).toMatchObject({
      title: MENU_RISK_TITLE,
      stepsHeading: "What to check",
      steps: MENU_INJECTION_STEPS,
      showSafetyBadge: false,
      primaryEditorButton: false,
      truncateSnippet: false,
    });
    expect(getFindingRemediation(MENU)).toBe(
      MENU_INJECTION_STEPS.map((s, i) => `${i + 1}. ${s}`).join(" "),
    );
    expect(getFindingImpact(MENU)).toMatch(/shoppers' browsers/);
  });

  it("copied steps name the kind of code, the location and what was seen", () => {
    const text = buildRemovalInstructions(menuFinding, FINDING_TYPE_LABELS[MENU]);
    expect(text).toContain(menuFinding.description);
    expect(text).toContain("Location: Menu item");
    expect(text).toContain("Seen as:");
    expect(text).toContain("Main menu > Shop");
  });

  it("merchant copy has no dashes, never says 'Ghost Code', and never claims GhostCode edits menus", () => {
    const texts = [
      ...MENU_INJECTION_STEPS,
      getFindingImpact(MENU) ?? "",
      findingCostLine(MENU),
      MENU_RISK_TITLE,
      VERDICT_MENU,
      FINDING_TYPE_LABELS[MENU],
      ...Object.values(getFindingCardCopy(MENU)).filter((v): v is string => typeof v === "string"),
    ];
    for (const text of texts) {
      expect(text, text).not.toMatch(/[—–]/);
      expect(text, text).not.toMatch(/ghost code/i);
      expect(text, text).not.toMatch(/GhostCode (will )?(remove|delete|edit)s?/);
    }
  });
});

describe("Security risk banner", () => {
  const [risk] = buildSecurityRisks({ advisories: [menuFinding], malicious: [], now: new Date() });

  it("an own-section MENU_INJECTION finding becomes one menu banner, built from its snippet", () => {
    const finding = { id: "f-menu", filename: menuFinding.filename, lineNumber: 0 };
    expect(risk).toEqual<MenuRisk>({
      kind: "menu",
      finding,
      items: [
        { finding, menuPath: "Main menu > Shop", seenAs: "Label: Shop<img src=x onerror=x()>" },
      ],
      description: menuFinding.description,
    });
    expect(securityRiskAnchorId(risk)).toBe("finding-f-menu");
    expect(securityRiskTitle(risk)).toBe(MENU_RISK_TITLE);
    expect(securityRiskSourceLabel(risk)).toBeNull();
    expect(securityRiskBody(risk)).toContain("remove it now");
    expect(securityRiskBody(risk)).toMatch(/GhostCode found it in this menu item:$/);
  });

  // gc-7gjj.6: the menu path and excerpt are the store's (attacker's) text.
  it("never puts the menu path or excerpt inside GhostCode's sentences", () => {
    for (const text of [securityRiskTitle(risk), securityRiskBody(risk)]) {
      expect(text).not.toContain("Main menu > Shop");
      expect(text).not.toContain("onerror");
    }
  });

  it("a snippet without an excerpt still reads cleanly", () => {
    const [bare] = buildSecurityRisks({
      advisories: [{ ...menuFinding, codeSnippet: "" }],
      malicious: [],
      now: new Date(),
    });
    expect(bare.kind === "menu" && bare.items).toEqual([
      expect.objectContaining({ menuPath: "A menu", seenAs: null }),
    ]);
  });

  // Deferred LOW (gc-7gjj.1): one banner per menu, not one per item.
  describe("grouped per menu", () => {
    const item = (id: string, menuId: string, title: string) => ({
      ...menuFinding,
      id,
      filename: `menus/${menuId}/items/${id}/0123456789abcdef`,
      codeSnippet: `Main menu > ${title}\nLabel: ${title}<svg onload=x()>`,
    });
    const many = [
      item("a1", "11", "One"),
      item("b1", "12", "Footer"),
      item("a2", "11", "Two"),
      ...Array.from({ length: 6 }, (_, n) => item(`a${n + 3}`, "11", `Item ${n + 3}`)),
    ];
    const risks = buildSecurityRisks({ advisories: many, malicious: [], now: new Date() });

    it("groups the items of each menu into one banner, at its first item's place", () => {
      expect(risks.map((r) => (r.kind === "menu" ? r.items.map((i) => i.finding.id) : []))).toEqual(
        [["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"], ["b1"]],
      );
      expect(securityRiskAnchorId(risks[0])).toBe("finding-a1");
      expect(securityRiskTitle(risks[0])).toBe("8 items in one of your store's menus contain code");
      expect(securityRiskBody(risks[0])).toContain(MENU_RISK_GROUP_FACTS);
      expect(securityRiskBody(risks[0])).toMatch(/GhostCode found it in these menu items:$/);
      expect(securityRiskTitle(risks[1])).toBe(MENU_RISK_TITLE);
      expect(countKeptSecurityRisks(risks, new Set())).toBe(2);
    });

    const render = (props: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(SecurityRiskBanner, {
            risk: risks[0],
            scanDate: "2026-10-27T00:00:00Z",
            ...props,
          }),
        ),
      );

    it("Home lists up to MENU_RISK_ITEMS_SHOWN items, then 'And K more in this menu.'", () => {
      const html = render({ checkHref: "/app/scans/s#finding-a1" });
      expect(MENU_RISK_ITEMS_SHOWN).toBe(5);
      expect(html.match(/<s-box/g)).toHaveLength(5);
      expect(html).toContain("Main menu &gt; Item 5");
      expect(html).not.toContain("Main menu &gt; Item 6");
      expect(html).toContain("And 3 more in this menu.");
    });

    it("the scan page lists every item, each anchored after the first, with its own control", () => {
      const html = render({
        anchor: true,
        menuItemsLimit: Infinity,
        menuItemFooter: (i: { finding: { id: string } }) =>
          createElement("span", { className: "ignore" }, `ignore-${i.finding.id}`),
      });
      expect(html.match(/<s-box/g)).toHaveLength(8);
      expect(html).not.toContain("more in this menu");
      expect(html).toContain('id="finding-a1"');
      expect(html).toContain('id="finding-a2"');
      expect(html.match(/id="finding-a1"/g)).toHaveLength(1);
      expect(html).toContain("ignore-a8");
    });
  });

  it("malicious banners come first, then the own-section banners in the order given", () => {
    const risks = buildSecurityRisks({
      advisories: [menuFinding, { ...menuFinding, id: "other", findingType: "GHOST_SCRIPT" }],
      malicious: [],
      now: new Date(),
    });
    expect(risks.map((r) => r.kind)).toEqual(["menu"]);
  });

  it("renders the label as quoted code in its own box, apart from the sentence (gc-7gjj.6)", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SecurityRiskBanner, { risk, scanDate: "2026-10-27T00:00:00Z" }),
      ),
    );
    const facts = html.slice(html.indexOf("<p"), html.indexOf("</p>"));
    expect(facts).not.toContain("Main menu");
    expect(html).toMatch(
      /<s-box[^>]*><code[^>]*>Main menu &gt; Shop<\/code><code[^>]*>Label: Shop&lt;img/,
    );
  });

  it("renders as markup-safe text (the label is escaped, never run)", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SecurityRiskBanner, { risk, scanDate: "2026-10-27T00:00:00Z", anchor: true }),
      ),
    );
    expect(html).toContain(">Security risk<");
    expect(html).toContain(`id="finding-f-menu"`);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=x()&gt;");
  });

  it("counts as one kept risk (an ignored one has no banner at all)", () => {
    expect(countKeptSecurityRisks([risk], new Set(["f-menu"]))).toBe(1);
  });

  it("Home's summary line names menu items with code", () => {
    expect(homeRiskSummaryLine({ advisories: 0, malicious: 0, leftover: 3, menu: 1 })).toBe(
      "1 menu item with code, 3 leftover items.",
    );
    expect(homeRiskSummaryLine({ advisories: 1, malicious: 2, leftover: 0, menu: 2 })).toBe(
      "2 pieces of known malicious code, 2 menu items with code, 1 app security advisory.",
    );
    expect(homeRiskSummaryLine({ advisories: 0, malicious: 0, leftover: 3 })).toBeNull();
  });
});

describe("theme health: the Menu labels check", () => {
  const coverage = (over: Partial<HealthCoverageInput> = {}): HealthCoverageInput => ({
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
    liveTypes: new Set(Object.values(FindingType)),
    liveNow: new Set(Object.values(FindingType)),
    planWithheld: [],
    isPublishedTheme: true,
    ...over,
  });

  it("found: a failed row linking to the scan, and the red verdict", () => {
    const row = menuHealthRow("scan-1", 2, coverage())!;
    expect(row).toMatchObject({
      key: "menu-labels",
      status: "issues",
      count: 2,
      href: "/app/scans/scan-1",
    });
    expect(row.detail).toBe("2 menu items contain code that could run in shoppers' browsers.");
    const groups = groupHealthRows([row]);
    expect(groups.menu).toBe(row);
    expect(themeHealthVerdict(groups)).toEqual({ tone: "critical", text: VERDICT_MENU });
  });

  it("code in a menu outranks an advisory in the verdict", () => {
    const advisory = { ...menuHealthRow("s", 1, coverage())!, key: "app-advisories" as const };
    const groups = groupHealthRows([advisory, menuHealthRow("s", 1, coverage())!]);
    expect(themeHealthVerdict(groups)?.text).toBe(VERDICT_MENU);
    expect(themeHealthVerdict({ ...groups, menu: null })?.text).toBe(VERDICT_ADVISORY);
  });

  it("checked and clean: a clean chip", () => {
    const row = menuHealthRow("scan-1", 0, coverage())!;
    expect(row.status).toBe("clean");
    expect(groupHealthRows([row]).clean).toEqual([row]);
  });

  it("capped: partly checked", () => {
    expect(menuHealthRow("s", 0, coverage({ cappedCategories: [MENU] }))?.status).toBe("partial");
  });

  it("permission not granted: not checked, with the permission line (never Clean)", () => {
    const row = menuHealthRow("s", 0, coverage({ skippedCategories: [MENU] }))!;
    expect(row.status).toBe("not_checked");
    expect(row.detail).toMatch(/permission/);
    expect(groupHealthRows([row]).gaps).toEqual([row]);
  });

  it("live now but this scan did not run it: not checked, run a new scan", () => {
    const liveTypes = new Set(Object.values(FindingType).filter((t) => t !== MENU));
    expect(menuHealthRow("s", 0, coverage({ liveTypes }))).toMatchObject({
      status: "not_checked",
      detail: expect.stringMatching(/Run a new scan/),
    });
  });

  it("dark (flag off for everyone): no row at all", () => {
    const liveNow = new Set(Object.values(FindingType).filter((t) => t !== MENU));
    expect(menuHealthRow("s", 0, coverage({ liveNow }))).toBeNull();
  });
});

describe("differ: a skipped or dark menu check never resolves or invents a finding", () => {
  const prior = { ...menuFinding, severity: "HIGH", appName: null };
  const coverageWith = (over: Record<string, unknown>) => ({
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
    skippedFiles: [],
    liveFindingTypes: Object.values(FindingType),
    ...over,
  });

  it("scope missing this scan: the prior finding is not resolved", () => {
    const diff = diffScans(
      [],
      [prior],
      scanDiffOptions(coverageWith({ skippedCategories: [MENU] }), coverageWith({})),
    );
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("not live this scan (flag off or the walk did not run): not resolved", () => {
    const live = Object.values(FindingType).filter((t) => t !== MENU);
    const diff = diffScans(
      [],
      [prior],
      scanDiffOptions(coverageWith({ liveFindingTypes: live }), coverageWith({})),
    );
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("capped this scan: not resolved", () => {
    const diff = diffScans(
      [],
      [prior],
      scanDiffOptions(coverageWith({ cappedCategories: [MENU] }), coverageWith({})),
    );
    expect(diff.resolvedFindings).toEqual([]);
  });

  it("checked in full and gone: resolved", () => {
    const diff = diffScans([], [prior], scanDiffOptions(coverageWith({}), coverageWith({})));
    expect(diff.resolvedFindings).toHaveLength(1);
  });

  it("the baseline did not check menus: a current finding is not 'new'", () => {
    const diff = diffScans(
      [prior],
      [],
      scanDiffOptions(coverageWith({}), coverageWith({ skippedCategories: [MENU] })),
    );
    expect(diff.newFindings).toEqual([]);
  });

  it("a missing navigation scope never makes MALICIOUS_SCRIPT un-audited", () => {
    const malicious = {
      ...prior,
      findingType: "MALICIOUS_SCRIPT",
      filename: "layout/theme.liquid",
    };
    const diff = diffScans(
      [],
      [malicious],
      scanDiffOptions(coverageWith({ skippedCategories: [MENU] }), coverageWith({})),
    );
    expect(diff.resolvedFindings).toHaveLength(1);
  });
});

describe("soft-launch flag MENU_INJECTION_LIVE_ENABLED", () => {
  afterEach(() => {
    delete process.env.MENU_INJECTION_LIVE_ENABLED;
  });

  it("is dark unless exactly 'true'", () => {
    expect(isMenuInjectionLive()).toBe(false);
    for (const value of ["1", "TRUE", "yes", ""]) {
      process.env.MENU_INJECTION_LIVE_ENABLED = value;
      expect(isMenuInjectionLive(), value).toBe(false);
    }
    process.env.MENU_INJECTION_LIVE_ENABLED = "true";
    expect(isMenuInjectionLive()).toBe(true);
    expect(isSoftLaunchLive(FindingType.MENU_INJECTION)).toBe(true);
  });
});

describe("migration 20261027100000_menu_injection_finding_type", () => {
  const NAME = "20261027100000_menu_injection_finding_type";
  const SQL = readFileSync(join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
  const CODE = SQL.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  it("adds exactly the one enum value, idempotently, and touches no table", () => {
    expect(CODE).toBe(`ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'MENU_INJECTION';`);
    expect(CODE).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|TABLE|COLUMN)\b/i);
  });

  it("documents the manual rollback", () => {
    expect(SQL).toMatch(/Enum values cannot be dropped in Postgres/);
    expect(SQL).toMatch(/DELETE FROM "Finding" WHERE "findingType" = 'MENU_INJECTION'/);
  });

  it("matches the Prisma schema and sorts after every earlier migration", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/enum FindingType \{[^}]*?\n\s+MENU_INJECTION\n/);
    const dirs = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(dirs.indexOf(NAME)).toBeGreaterThan(dirs.indexOf("20261020120000_add_change_log"));
  });
});
