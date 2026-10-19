/**
 * Tests for app/components/TopFindings.tsx (gc-bn0x, redesigned gc-g034): the
 * shared "Start here" block. Rendered with react-dom/server inside a
 * MemoryRouter (the same tree the routes render it in).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, it, expect } from "vitest";

import {
  SECURITY_RISK_LABEL,
  TopFindings,
  topFindingsIntro,
} from "../../app/components/TopFindings";
import { LANES } from "../../app/lib/finding-consequence";
import type { LaneKey } from "../../app/lib/finding-consequence";
import type { TopFindingView } from "../../app/lib/top-findings";
import { LANE_COLOR, SECURITY_RISK_COLOR } from "../../app/styles/lane-colors";

function view(n: number, over: Partial<TopFindingView> = {}): TopFindingView {
  return {
    id: `f${n}`,
    severity: "HIGH",
    lane: "speed",
    securityRisk: false,
    typeLabel: `Type ${n}`,
    location: `snippets/file-${n}.liquid, line ${n}`,
    cost: `Cost line ${n}.`,
    href: `/app/scans/scan-1#finding-f${n}`,
    appName: null,
    ...over,
  };
}

function render(findings: TopFindingView[], newlyInactiveApps?: string[]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(TopFindings, { findings, newlyInactiveApps })),
  );
}

/** The markup of each card (<li>), in order. */
function cards(html: string): string[] {
  return html.split(/<li /).slice(1);
}

/** The lowercase hex React SSR writes for an inline colour. */
const hex = (c: string) => c.toLowerCase();

describe("TopFindings", () => {
  it("renders nothing for 0 findings (the clean-scan state stays as is)", () => {
    expect(render([])).toBe("");
  });

  it.each([1, 2, 3])("renders exactly %i cards as an ordered list, in a %i-column grid", (n) => {
    const html = render(Array.from({ length: n }, (_, i) => view(i + 1)));
    expect(html.match(/<li[ >]/g)).toHaveLength(n);
    expect(html).toMatch(new RegExp(`<ol class="top-findings__grid top-findings__grid--${n}"`));
    // The column rule for that count exists, and phones stack to one column.
    expect(html).toContain(
      `.top-findings__grid--${n} { grid-template-columns: repeat(${n}, minmax(0, 1fr)); }`,
    );
    expect(html).toMatch(
      /@media \(max-width: 600px\) \{\s*\.top-findings__grid \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    );
  });

  it("caps the block at 3 cards even if handed more", () => {
    const html = render([1, 2, 3, 4].map((n) => view(n)));
    expect(html.match(/<li[ >]/g)).toHaveLength(3);
    expect(html).toContain("top-findings__grid--3");
    expect(html).not.toContain("Type 4");
  });

  it("keeps the list semantics with the bullets turned off", () => {
    const html = render([view(1)]);
    expect(html).toContain("<ol");
    expect(html).toMatch(/\.top-findings__grid \{[^}]*list-style: none;/);
  });

  it("each card shows its number, title, cost, and location", () => {
    const html = render([view(1), view(2)]);
    const [first, second] = cards(html);
    expect(first).toMatch(/<span class="top-findings__num"[^>]*aria-hidden="true">1<\/span>/);
    expect(second).toMatch(/aria-hidden="true">2<\/span>/);
    expect(first).toMatch(/<h3 class="top-findings__title">Type 1<\/h3>/);
    expect(first).toContain("Cost line 1.");
    expect(first).toMatch(
      /<div class="top-findings__location">snippets\/file-1\.liquid, line 1<\/div>/,
    );
  });

  it("is a labelled region with a heading, and never a live region", () => {
    const html = render([view(1), view(2)]);
    expect(html).toContain('aria-labelledby="top-findings-heading"');
    expect(html).toMatch(/<h2 id="top-findings-heading"[^>]*>Start here<\/h2>/);
    expect(html).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  describe("See how to fix button", () => {
    it("is a secondary Polaris button to the finding's row, with the full accessible label", () => {
      const html = render([view(1)]);
      expect(html).toContain(
        '<s-button variant="secondary" href="/app/scans/scan-1#finding-f1" accessibilityLabel="See how to fix: Type 1, snippets/file-1.liquid, line 1">See how to fix</s-button>',
      );
      // No plain anchor: the s-button carries the in-app navigation.
      expect(html).not.toContain("<a ");
    });

    it("keeps a type's own link text and title (an advisory)", () => {
      const html = render([
        view(1, {
          lane: null,
          securityRisk: true,
          title: "Hulk is in your theme and was named in a security incident",
          linkLabel: "See what to check",
        }),
      ]);
      expect(html).toContain(
        'accessibilityLabel="See what to check: Hulk is in your theme and was named in a security incident, snippets/file-1.liquid, line 1">See what to check</s-button>',
      );
    });

    it("keeps a filtered-list href (query and hash) as is", () => {
      const href = "/app/scans/scan-1?type=GHOST_SCRIPT#finding-f1";
      expect(render([view(1, { href })])).toContain(`href="${href.replace("&", "&amp;")}"`);
    });
  });

  describe("lane chip and colours", () => {
    it.each(LANES.map((l) => [l.key, l.label] as [LaneKey, string]))(
      "a %s finding uses that lane's tint, border, stripe, ink and label",
      (lane, label) => {
        const c = LANE_COLOR[lane];
        const [card] = cards(render([view(1, { lane })]));
        expect(card).toContain(`background:${hex(c.tint)}`);
        expect(card).toContain(`border:1px solid ${hex(c.bd)}`);
        expect(card).toContain(`border-top:4px solid ${hex(c.fill)}`);
        // Number circle and chip dot in the fill; chip text in the ink.
        expect(card).toMatch(
          new RegExp(`class="top-findings__num" style="background:${hex(c.fill)}"`),
        );
        expect(card).toMatch(
          new RegExp(`class="top-findings__dot" style="background:${hex(c.fill)}"`),
        );
        const escaped = label.replace("&", "&amp;");
        expect(card).toMatch(
          new RegExp(
            `<span class="top-findings__chip" style="color:${hex(c.ink)}">.*${escaped}</span>`,
          ),
        );
        expect(card).not.toContain(SECURITY_RISK_LABEL);
      },
    );

    it("cards in different lanes get different colours", () => {
      const [a, b] = cards(render([view(1, { lane: "discoverability" }), view(2)]));
      expect(a).toContain(hex(LANE_COLOR.discoverability.tint));
      expect(b).toContain(hex(LANE_COLOR.speed.tint));
      expect(a).not.toContain(hex(LANE_COLOR.speed.tint));
    });

    it("an advisory (no lane) is a red Security risk card", () => {
      const [card] = cards(render([view(1, { lane: null, securityRisk: true })]));
      expect(card).toContain(`background:${hex(SECURITY_RISK_COLOR.tint)}`);
      expect(card).toContain(`border-top:4px solid ${hex(SECURITY_RISK_COLOR.fill)}`);
      expect(card).toContain(`color:${hex(SECURITY_RISK_COLOR.ink)}`);
      expect(card).toContain(`${SECURITY_RISK_LABEL}</span>`);
      expect(SECURITY_RISK_LABEL).toBe("Security risk");
    });

    it("malicious code (primary lane privacy) is a Security risk card, not the privacy lane", () => {
      const [card] = cards(render([view(1, { lane: "privacy", securityRisk: true })]));
      expect(card).toContain(`border-top:4px solid ${hex(SECURITY_RISK_COLOR.fill)}`);
      expect(card).toContain(`${SECURITY_RISK_LABEL}</span>`);
      expect(card).not.toContain("Still tracking you");
      expect(card).not.toContain(hex(LANE_COLOR.privacy.tint));
    });
  });

  describe("from {App}", () => {
    it("follows the title, in subdued text, when the app is known", () => {
      const [card] = cards(render([view(1, { appName: "PageFly" })]));
      expect(card).toMatch(
        /<h3 class="top-findings__title">Type 1<span class="top-findings__app"> from PageFly<\/span><\/h3>/,
      );
    });

    it("is left out when the app is unknown", () => {
      expect(render([view(1)])).not.toContain(" from ");
    });

    it("is left out when the title already names the app (an advisory's own title)", () => {
      const html = render([
        view(1, {
          lane: null,
          securityRisk: true,
          appName: "Hulk",
          title: "Hulk is in your theme and was named in a security incident",
        }),
      ]);
      expect(html).not.toContain('class="top-findings__app"');
      expect(html).not.toContain("from Hulk");
    });
  });

  describe("severity", () => {
    it("all the same: said once in the intro, no badge on any card", () => {
      const html = render([view(1), view(2), view(3)]);
      expect(html).toContain("Fix these 3 first. All three are high severity.");
      expect(html).not.toContain("<s-badge");
    });

    it("mixed: a plain intro and a badge on every card, after its title", () => {
      const html = render([
        view(1, { severity: "HIGH" }),
        view(2, { severity: "MEDIUM" }),
        view(3, { severity: "LOW" }),
      ]);
      expect(html).toContain("<p");
      expect(html).toMatch(/>Fix these 3 first\.<\/p>/);
      const [a, b, c] = cards(html);
      expect(a).toMatch(
        /<h3 class="top-findings__title">Type 1<\/h3><s-badge tone="critical">HIGH<\/s-badge>/,
      );
      expect(b).toContain('<s-badge tone="warning">MEDIUM</s-badge>');
      expect(c).toContain('<s-badge tone="info">LOW</s-badge>');
    });

    it("intro copy for one, two and three of a kind, and mixed, with no dashes", () => {
      expect(topFindingsIntro(["HIGH"])).toBe("Fix this first. It's high severity.");
      expect(topFindingsIntro(["LOW"])).toBe("Fix this first. It's low severity.");
      expect(topFindingsIntro(["MEDIUM", "MEDIUM"])).toBe(
        "Fix these 2 first. Both are medium severity.",
      );
      expect(topFindingsIntro(["HIGH", "HIGH", "HIGH"])).toBe(
        "Fix these 3 first. All three are high severity.",
      );
      expect(topFindingsIntro(["HIGH", "LOW"])).toBe("Fix these 2 first.");
      expect(topFindingsIntro(["HIGH", "HIGH", "MEDIUM"])).toBe("Fix these 3 first.");
      for (const s of [["HIGH"], ["HIGH", "LOW"], ["LOW", "LOW", "LOW"]] as const) {
        expect(topFindingsIntro(s)).not.toMatch(/[–—]/);
      }
    });
  });

  describe("New · {App} badge (gc-frda)", () => {
    const fromApp = (n: number, appName: string | null): TopFindingView => view(n, { appName });

    it("badges a finding whose app is newly inactive on the scan, next to its title", () => {
      const html = render([fromApp(1, "Yotpo"), fromApp(2, "Privy")], ["Yotpo"]);
      expect(html).toMatch(/ from Yotpo<\/span><\/h3><span style="[^"]*">New · Yotpo<\/span>/);
      expect(html).not.toContain("New · Privy");
      expect(html.match(/New · /g)).toHaveLength(1);
    });

    it("no set (Home with nothing inactive, or a page that passes none): no badge", () => {
      expect(render([fromApp(1, "Yotpo")])).not.toContain("New · ");
      expect(render([fromApp(1, "Yotpo")], [])).not.toContain("New · ");
    });

    it("an unattributed finding never gets the badge", () => {
      expect(render([fromApp(1, null)], ["Yotpo"])).not.toContain("New · ");
    });

    it("uses the shared NEW badge style (no inline hex of its own)", () => {
      const html = render([fromApp(1, "Yotpo")], ["Yotpo"]);
      // styles.newBadge renders uppercase on a tinted chip.
      expect(html).toMatch(/<span style="[^"]*text-transform:uppercase[^"]*">New · Yotpo/);
    });
  });
});
