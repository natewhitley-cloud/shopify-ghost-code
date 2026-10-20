/**
 * Tests for the Security risk banner (gc-q5z8): app/components/SecurityRiskBanner.tsx,
 * its copy (app/lib/security-risk.ts) and the server builder that resolves
 * stored findings against the curated lists (app/services/security-risk.server.ts).
 * Rendered with react-dom/server inside a MemoryRouter (Home's button is a Link).
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, it, expect } from "vitest";

import { SecurityRiskBanner } from "../../app/components/SecurityRiskBanner";
import {
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
  type AppIncidentAdvisory,
} from "../../app/data/app-incident-advisories.server";
import {
  homepageMaliciousDescription,
  KNOWN_MALICIOUS_DOMAINS,
  maliciousDescription,
} from "../../app/data/malicious-domains.server";
import { getFindingCardCopy, getFindingImpact } from "../../app/lib/finding-remediation";
import {
  advisoryCheckSteps,
  findingsTileSubtitle,
  homeRiskSummaryLine,
  securityRiskAnchorId,
  securityRiskBody,
  securityRiskSourceLabel,
  securityRiskTitle,
  totalFindingsNote,
  type AdvisoryRisk,
  type SecurityRisk,
} from "../../app/lib/security-risk";
import { toTopFindingViews } from "../../app/lib/top-findings";
import { advisoryStartHereCopy, buildSecurityRisks } from "../../app/services/security-risk.server";

const NOW = new Date("2026-10-19T12:00:00Z");
const entry = (name: string): AppIncidentAdvisory =>
  APP_INCIDENT_ADVISORIES.find((a) => a.appName === name)!;
const SELLEASY = entry("Selleasy");
const SWYM = entry("Swym Wishlist Plus");
const HULK = entry("Hulk Product Options");

type Stored = {
  id: string;
  findingType: string;
  filename: string;
  lineNumber: number;
  description: string;
};

const embedFinding = (advisory: AppIncidentAdvisory, id = "adv"): Stored => ({
  id,
  findingType: "APP_INCIDENT_ADVISORY",
  filename: "config/settings_data.json",
  lineNumber: 1,
  description: advisoryDescription({ advisory, embedHandle: advisory.embedHandles[0] }),
});
const hostFinding = (advisory: AppIncidentAdvisory, id = "adv-host"): Stored => ({
  id,
  findingType: "APP_INCIDENT_ADVISORY",
  filename: "layout/theme.liquid",
  lineNumber: 12,
  description: advisoryDescription({ advisory, scriptHost: advisory.scriptHosts[0] }),
});
const BILIING = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === "biliing.top")!;
const POLYFILL = KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === "polyfill.io")!;
const malFinding = (id: string, filename: string, line: number, d = BILIING): Stored => ({
  id,
  findingType: "MALICIOUS_SCRIPT",
  filename,
  lineNumber: line,
  description: maliciousDescription(d),
});

function risksOf(advisories: Stored[], malicious: Stored[] = [], now = NOW): SecurityRisk[] {
  return buildSecurityRisks({ advisories, malicious, now });
}

function render(
  risk: SecurityRisk,
  props: { checkHref?: string; anchor?: boolean; children?: ReactNode } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(SecurityRiskBanner, {
        risk,
        scanDate: "2026-10-19T10:01:00Z",
        ...props,
      }),
    ),
  );
}

/** Visible text, tags stripped, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("SecurityRiskBanner: an advisory matched by its app embed (Selleasy)", () => {
  const [risk] = risksOf([embedFinding(SELLEASY)]);

  it("names the app, quotes the developer with the date, and says what GhostCode found", () => {
    const t = text(render(risk, { checkHref: "/app/scans/scan-1#finding-adv" }));
    expect(t).toContain("Security risk");
    expect(t).toContain(
      "Selleasy is in your theme, and its developer reported a security incident",
    );
    expect(t).toContain(
      "On 13 October 2026, Logbase (Selleasy's developer) reported that an unauthorized script on some stores sent shoppers to a phishing page.",
    );
    expect(t).toContain("Your live theme has the Selleasy app embed turned on.");
    expect(t).toContain("GhostCode can't tell whether your store was affected, so check it now.");
    expect(t).toContain("Found in your Oct 19, 2026 scan · shown on every plan");
  });

  it("Home: the primary button links to the banner on the scan page, then the statement link", () => {
    const html = render(risk, { checkHref: "/app/scans/scan-1#finding-adv" });
    expect(html).toMatch(
      /<a href="\/app\/scans\/scan-1#finding-adv"[^>]*><s-button variant="primary">See what to check<\/s-button><\/a>/,
    );
    expect(html).toContain(
      '<a href="https://www.logbase.io/selleasy/updates/incident-20261013" target="_blank" rel="noopener noreferrer"',
    );
    expect(text(html)).toContain("Read Selleasy's statement");
    expect(html.indexOf("See what to check")).toBeLessThan(html.indexOf("Read Selleasy"));
    // Home renders it without the anchor (the scan page's banner carries it).
    expect(html).not.toContain('id="finding-adv"');
  });

  it("scan page: anchored at the finding's own id, steps inline, no See what to check button", () => {
    const html = render(risk, { anchor: true, children: createElement("ol", null, "steps") });
    expect(html).toContain('<section id="finding-adv" aria-labelledby="finding-adv-title"');
    expect(html).toContain('<h2 id="finding-adv-title"');
    expect(html).toContain("<ol>steps</ol>");
    expect(html).not.toContain("See what to check");
    expect(securityRiskAnchorId(risk)).toBe("finding-adv");
  });

  it("the What to check steps name the app in the last step (embed wording)", () => {
    const steps = advisoryCheckSteps(risk as AdvisoryRisk);
    expect(steps).toHaveLength(5);
    expect(steps[4]).toBe(
      "If you no longer use Selleasy, uninstall it, or turn off its embed in Online Store, Themes, Customize, App embeds. If you still use it, ask the developer whether this affects you.",
    );
    expect(steps.slice(0, 4)).toEqual(
      (getFindingCardCopy("APP_INCIDENT_ADVISORY", "config/settings_data.json").steps ?? []).slice(
        0,
        4,
      ),
    );
  });
});

describe("advisoryCheckSteps substitution", () => {
  it("names the app on both signals, and a '$' in a name is taken literally", () => {
    const [embed] = risksOf([embedFinding(SELLEASY)]);
    const [host] = risksOf([hostFinding(SELLEASY)]);
    for (const risk of [embed, host] as AdvisoryRisk[]) {
      expect(advisoryCheckSteps(risk)[4]).toMatch(/^If you no longer use Selleasy, /);
      expect(advisoryCheckSteps(risk).join(" ")).not.toContain("use the app,");
      expect(advisoryCheckSteps({ ...risk, appName: "A$&B $1" })[4]).toMatch(
        /^If you no longer use A\$&B \$1, /,
      );
    }
  });
});

describe("SecurityRiskBanner: an advisory matched by a script host", () => {
  it("Selleasy host: names the host and the file and line", () => {
    const [risk] = risksOf([hostFinding(SELLEASY)]);
    expect(securityRiskBody(risk)).toContain(
      "Your live theme loads a script from upsell-app.logbase.io (layout/theme.liquid, line 12).",
    );
    expect(advisoryCheckSteps(risk as AdvisoryRisk)[4]).toMatch(
      /^If you no longer use Selleasy, remove its script line/,
    );
  });

  it("Hulk (a third-party report): 'named in a security incident report', 'Read the report'", () => {
    const [risk] = risksOf([hostFinding(HULK)]);
    expect(securityRiskTitle(risk)).toBe(
      "Hulk Product Options is in your theme, and it was named in a security incident report",
    );
    expect(securityRiskBody(risk)).toMatch(
      /^On 10 October 2026, a public report described Hulk Product Options delivering code that sent shoppers to a fake checkout page on at least one store\. /,
    );
    expect(securityRiskSourceLabel(risk)).toBe("Read the report");
  });
});

describe("SecurityRiskBanner: known malicious code", () => {
  it("one banner per domain, naming the domain, every line, and no source link", () => {
    const risks = risksOf(
      [],
      [
        malFinding("m2", "snippets/cart.liquid", 12),
        malFinding("m1", "layout/theme.liquid", 31),
        malFinding("m3", "layout/theme.liquid", 40, POLYFILL),
      ],
    );
    expect(risks).toHaveLength(2);
    const biliing = risks.find((r) => r.kind === "malicious" && r.domain === "biliing.top")!;
    expect(securityRiskTitle(biliing)).toBe(
      "Your theme references biliing.top, a domain linked to malicious code",
    );
    const html = render(biliing, { checkHref: "/app/scans/scan-1#security-risk-m1" });
    const t = text(html);
    expect(t).toContain(
      "GhostCode lists biliing.top as a source of malicious code (fake checkout domain from a 2026 card-phishing attack on Shopify stores).",
    );
    // Theme order, both lines.
    expect(t).toContain(
      "GhostCode found biliing.top on 2 lines of your theme (layout/theme.liquid, line 31; snippets/cart.liquid, line 12).",
    );
    expect(t).toContain("Remove it as soon as possible.");
    expect(html).not.toContain('target="_blank"');
    expect(securityRiskAnchorId(biliing)).toBe("security-risk-m1");
    // A domain added in good faith keeps its own advice, not "added without knowing".
    const polyfill = risks.find((r) => r.kind === "malicious" && r.domain === "polyfill.io")!;
    expect(securityRiskBody(polyfill)).toContain("It is no longer under trusted control.");
    expect(securityRiskBody(polyfill)).not.toContain("without the store owner knowing");
  });

  it("more than three lines are summarised", () => {
    const [risk] = risksOf(
      [],
      [1, 2, 3, 4, 5].map((n) => malFinding(`m${n}`, "layout/theme.liquid", n)),
    );
    expect(securityRiskBody(risk)).toContain(
      "on 5 lines of your theme (layout/theme.liquid, line 1; layout/theme.liquid, line 2; layout/theme.liquid, line 3; and 2 more)",
    );
  });

  it("an unknown description (entry removed or reworded) still renders, from the stored text", () => {
    const [risk] = risksOf(
      [],
      [{ ...malFinding("m1", "layout/theme.liquid", 3), description: "References old.example" }],
    );
    expect(securityRiskTitle(risk)).toBe("Your theme references a domain linked to malicious code");
    expect(securityRiskBody(risk)).toMatch(
      /^References old\.example\. GhostCode found it on 1 line/,
    );
  });
});

describe("buildSecurityRisks: several risks, ordering and fallbacks", () => {
  it("malicious first, then one banner per advisory in the order given", () => {
    const risks = risksOf(
      [embedFinding(SWYM, "a-swym"), embedFinding(SELLEASY, "a-sell")],
      [malFinding("m1", "layout/theme.liquid", 1)],
    );
    expect(risks.map((r) => (r.kind === "malicious" ? r.domain : r.appName))).toEqual([
      "biliing.top",
      "Swym Wishlist Plus",
      "Selleasy",
    ]);
    const html = risks.map((r) => render(r)).join("");
    expect(html.match(/>Security risk</g)).toHaveLength(3);
  });

  it("ignores rows of other types (the caller passes the page's lists)", () => {
    expect(
      risksOf(
        [{ ...embedFinding(SELLEASY), findingType: "GHOST_SCRIPT" }],
        [{ ...malFinding("m1", "x", 1), findingType: "GHOST_SCRIPT" }],
      ),
    ).toEqual([]);
  });

  it("an entry past its review date keeps its wording but loses the link", () => {
    const [risk] = risksOf([embedFinding(SELLEASY)], [], new Date("2027-02-01T00:00:00Z"));
    expect(securityRiskTitle(risk)).toContain("Selleasy");
    expect(securityRiskSourceLabel(risk)).toBeNull();
    expect(render(risk)).not.toContain('target="_blank"');
  });

  it("an advisory no entry produces falls back to neutral copy and the stored description", () => {
    const [risk] = risksOf([{ ...embedFinding(SELLEASY), description: "Has an old app embed" }]);
    expect(securityRiskTitle(risk)).toBe(
      "An app in your theme was named in a security incident report",
    );
    expect(securityRiskBody(risk)).toMatch(
      /^Has an old app embed\. Your live theme has this app's embed turned on\./,
    );
    expect(securityRiskSourceLabel(risk)).toBeNull();
  });
});

describe("per-entry wording (gc-q5z8): each advisory in its own source's words", () => {
  /** Every merchant-facing string any surface shows for one stored advisory. */
  function surfaces(finding: Stored): string[] {
    const [risk] = risksOf([finding]);
    const top = toTopFindingViews(
      "scan-1",
      [
        {
          ...finding,
          findingType: "APP_INCIDENT_ADVISORY",
          severity: "HIGH",
          createdAt: NOW,
          appName: null,
        },
      ],
      true,
      advisoryStartHereCopy([finding]),
    )[0];
    const card = getFindingCardCopy(finding.findingType, finding.filename);
    return [
      securityRiskTitle(risk),
      securityRiskBody(risk),
      securityRiskSourceLabel(risk) ?? "",
      ...advisoryCheckSteps(risk as AdvisoryRisk),
      top.title ?? "",
      top.cost,
      top.location,
      finding.description,
      card.title ?? "",
      card.confidence ?? "",
      getFindingImpact(finding.findingType, finding.filename) ?? "",
    ];
  }

  it.each([
    ["embed", embedFinding(SELLEASY)],
    ["host", hostFinding(SELLEASY)],
  ])(
    "Selleasy (%s): no merchant string says 'fake checkout page'; it says 'phishing page'",
    (_s, f) => {
      const all = surfaces(f).join("\n");
      expect(all).not.toMatch(/fake checkout/i);
      expect(all).toContain("phishing page");
    },
  );

  it("Swym keeps its own statement's 'fake checkout page'", () => {
    expect(surfaces(embedFinding(SWYM)).join("\n")).toContain(
      "Swym (Swym Wishlist Plus's developer) reported that an unauthorized change to its configuration made a script load on some storefronts that could send shoppers to a fake checkout page.",
    );
  });

  it("Start here names the app with its own wording, never the shared line", () => {
    const f = embedFinding(SELLEASY);
    const [view] = toTopFindingViews(
      "scan-1",
      [
        {
          ...f,
          findingType: "APP_INCIDENT_ADVISORY",
          severity: "HIGH",
          createdAt: NOW,
          appName: null,
        },
      ],
      true,
      advisoryStartHereCopy([f]),
    );
    expect(view.title).toBe("Selleasy is in your theme and was named in a security incident");
    expect(view.cost).toBe(
      "On 13 October 2026, Logbase (Selleasy's developer) reported that an unauthorized script on some stores sent shoppers to a phishing page.",
    );
  });

  it.each(APP_INCIDENT_ADVISORIES.map((a) => [a.appName, a] as const))(
    "%s: copy hygiene in every surface (GhostCode, no dashes, never 'hacked' or 'affected' about the store)",
    (_name, advisory) => {
      const findings = [
        ...(advisory.embedHandles.length ? [embedFinding(advisory)] : []),
        ...(advisory.scriptHosts.length ? [hostFinding(advisory)] : []),
      ];
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        const all = surfaces(f).join("\n");
        expect(all).not.toMatch(/[—–]/);
        expect(all).not.toMatch(/hack/i);
        // "can't tell whether your store was affected" is the one allowed form.
        expect(all).not.toMatch(
          /(?<!whether )your (store|checkout) (was|is|has been) (affected|compromised|hijacked)/i,
        );
        expect(all).not.toMatch(/Ghost Code|Ghostcode/);
        expect(all).toContain("GhostCode");
      }
    },
  );

  it("each entry's report completes 'On {date}, ...': no dash, no trailing period", () => {
    for (const a of APP_INCIDENT_ADVISORIES) {
      expect(a.report, a.appName).not.toMatch(/[—–]|\.$/);
      expect(a.report.length, a.appName).toBeGreaterThan(20);
    }
  });
});

describe("counts copy", () => {
  it("findingsTileSubtitle", () => {
    expect(findingsTileSubtitle(13, 1)).toBe("findings, 1 security risk");
    expect(findingsTileSubtitle(1, 1)).toBe("finding, 1 security risk");
    expect(findingsTileSubtitle(6, 2)).toBe("findings, 2 security risks");
    expect(findingsTileSubtitle(4, 0)).toBe("findings");
    expect(findingsTileSubtitle(1, 0)).toBe("finding");
  });

  it("totalFindingsNote", () => {
    expect(totalFindingsNote(13, 1)).toBe(
      "13 findings: 1 security risk (above), 12 leftover items (below).",
    );
    expect(totalFindingsNote(2, 1)).toBe(
      "2 findings: 1 security risk (above), 1 leftover item (below).",
    );
    expect(totalFindingsNote(1, 1)).toBe("1 finding: 1 security risk (above).");
    expect(totalFindingsNote(5, 0)).toBeNull();
  });

  it("totalFindingsNote on a paid page with kept malicious code says the list repeats it", () => {
    expect(totalFindingsNote(13, 3, 2)).toBe(
      "13 findings: 3 security risks (above), 10 leftover items (below, with the known malicious code listed again).",
    );
    expect(totalFindingsNote(2, 2, 2)).toBe(
      "2 findings: 2 security risks (above) (the known malicious code is listed again below).",
    );
  });

  it("homeRiskSummaryLine is null without a security risk", () => {
    expect(homeRiskSummaryLine({ advisories: 0, malicious: 0, leftover: 9 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Known malicious code seen at runtime (gc-0htk): homepage and speed test
// ---------------------------------------------------------------------------

describe("SecurityRiskBanner: known malicious code on the served homepage (gc-0htk)", () => {
  const homepage = (id: string, d = BILIING): Stored => ({
    id,
    findingType: "MALICIOUS_SCRIPT",
    filename: "storefront/homepage",
    lineNumber: 0,
    description: homepageMaliciousDescription(d),
  });

  it("says where it was seen and never points at theme files; separate from a theme hit", () => {
    const risks = risksOf([], [malFinding("m1", "layout/theme.liquid", 31), homepage("h1")]);
    expect(risks.map((r) => r.kind === "malicious" && r.seenIn)).toEqual(["theme", "homepage"]);
    const hp = risks[1];
    expect(securityRiskTitle(hp)).toBe(
      "Your live homepage uses biliing.top, a domain linked to malicious code",
    );
    const body = securityRiskBody(hp);
    expect(body).toContain("GhostCode lists biliing.top as a source of malicious code");
    expect(body).toContain(
      "GhostCode saw biliing.top on your live homepage, but not in your theme files, so it is most likely added by an app.",
    );
    expect(body).toContain("Find what adds it as soon as possible.");
    expect(body).not.toMatch(/line|theme\.liquid|[–—]/);
    expect(securityRiskAnchorId(hp)).toBe("security-risk-h1");
    const html = text(render(hp, { anchor: true }));
    expect(html).toContain("Found in your");
    expect(html).toContain("scan · shown on every plan");
    // The theme banner keeps its wording.
    expect(securityRiskTitle(risks[0])).toBe(
      "Your theme references biliing.top, a domain linked to malicious code",
    );
  });

  it("a good-faith entry's advice is dropped for a homepage hit (nothing in the theme to remove)", () => {
    const [risk] = risksOf([], [homepage("h1", POLYFILL)]);
    expect(risk.kind === "malicious" && risk.advice).toBeNull();
    expect(securityRiskBody(risk)).not.toContain("Remove this reference");
  });
});

describe("SecurityRiskBanner: known malicious code in the speed test (gc-0htk)", () => {
  const risk: SecurityRisk = {
    kind: "malicious",
    seenIn: "speed_test",
    speedPages: ["product"],
    domain: "checkout-guard.top",
    note: "fake checkout page that collects card details",
    advice: null,
    findings: [],
    description: "checkout-guard.top (fake checkout page that collects card details)",
  };

  it("names the speed test and the page, and dates it as a speed test", () => {
    expect(securityRiskTitle(risk)).toBe(
      "Your store's speed test loaded checkout-guard.top, a domain linked to malicious code",
    );
    expect(securityRiskBody(risk)).toContain(
      "In your latest store speed test, Google's test browser requested checkout-guard.top while loading your product page.",
    );
    expect(securityRiskAnchorId(risk)).toBe("security-risk-speed-checkout-guard.top");
    const html = text(render(risk, { anchor: true }));
    expect(html).toContain("Seen in your");
    expect(html).toContain("speed test · shown on every plan");
    expect(html).not.toContain("scan ·");
  });
});
