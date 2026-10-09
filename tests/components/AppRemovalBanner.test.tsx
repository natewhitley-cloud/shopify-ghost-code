/**
 * Tests for app/components/AppRemovalBanner.tsx (gc-frda): Home's banner for
 * apps no longer active in the store, or whose leftovers are cleaned up.
 * Rendered with react-dom/server inside a MemoryRouter (react-router Links).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, it, expect } from "vitest";

import { AppRemovalBanner } from "../../app/components/AppRemovalBanner";
import { buildRemovalNotice } from "../../app/lib/app-removal-notice";

function render(
  rows: Array<[string, number, string?]>,
  opts: { fullList?: boolean; linkParams?: URLSearchParams } = {},
): string {
  const notice = buildRemovalNotice(
    rows.map(([appName, leftoverCount, state = "REMOVED"]) => ({ appName, leftoverCount, state })),
  );
  if (!notice) throw new Error("fixture has no notice");
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(AppRemovalBanner, {
        notice,
        scanId: "scan-9",
        fullList: opts.fullList ?? true,
        linkParams: opts.linkParams,
        onDismiss: () => {},
      }),
    ),
  );
}

/** Visible text: tags stripped, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("AppRemovalBanner", () => {
  it("one app, paid: info banner, heading, body, Review N items to the filtered scan, Dismiss", () => {
    const html = render([["Yotpo", 3]]);
    expect(html).toMatch(
      /<s-banner tone="info" heading="Yotpo is no longer active in your store">/,
    );
    expect(html).toContain("<s-paragraph>It left 3 items behind.</s-paragraph>");
    expect(html).toMatch(
      /<a href="\/app\/scans\/scan-9\?app=Yotpo"[^>]*><s-button variant="primary">Review 3 items<\/s-button><\/a>/,
    );
    expect(html).toMatch(/<s-button variant="secondary">Dismiss<\/s-button>/);
    expect(html).not.toContain("<ul");
  });

  it("one app, Free: the primary says 'See what {App} left' (same link)", () => {
    const html = render([["Yotpo", 1]], { fullList: false });
    expect(html).toContain("It left 1 item behind.");
    expect(html).toMatch(
      /href="\/app\/scans\/scan-9\?app=Yotpo"[^>]*><s-button variant="primary">See what Yotpo left</,
    );
  });

  it("links keep the embedded params (host, shop)", () => {
    const html = render([["Yotpo", 3]], {
      linkParams: new URLSearchParams({ host: "h1", shop: "s.myshopify.com" }),
    });
    expect(html).toContain(
      'href="/app/scans/scan-9?host=h1&amp;shop=s.myshopify.com&amp;app=Yotpo"',
    );
  });

  it("several apps: count heading, total body, one linked line per app, Review {first}", () => {
    const html = render([
      ["Privy", 2],
      ["Yotpo", 5],
    ]);
    expect(html).toContain('heading="2 apps are no longer active in your store"');
    expect(html).toContain("Together they left 7 items behind.");
    const items = [...html.matchAll(/<li><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/li>/g)];
    expect(items.map((m) => [m[1], m[2]])).toEqual([
      ["/app/scans/scan-9?app=Yotpo", "Yotpo: 5 items"],
      ["/app/scans/scan-9?app=Privy", "Privy: 2 items"],
    ]);
    expect(html).toMatch(/<s-button variant="primary">Review Yotpo<\/s-button>/);
    expect(html).not.toContain("more");
  });

  it("caps the list at 5 apps and adds 'and N more'", () => {
    const html = render([
      ["A", 7],
      ["B", 6],
      ["C", 5],
      ["D", 4],
      ["E", 3],
      ["F", 2],
      ["G", 1],
    ]);
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).toContain("E: 3 items");
    expect(html).not.toContain("F: 2 items");
    expect(html).toContain("<s-paragraph>and 2 more</s-paragraph>");
    expect(html).toContain('heading="7 apps are no longer active in your store"');
  });

  it("exactly 5 apps: all listed, no overflow line", () => {
    const html = render([
      ["A", 1],
      ["B", 1],
      ["C", 1],
      ["D", 1],
      ["E", 1],
    ]);
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).not.toContain("more");
  });

  it("cleaned, one app: success banner, Dismiss only (no link, no primary)", () => {
    const html = render([["Privy", 2, "CLEANED"]]);
    expect(html).toMatch(
      /<s-banner tone="success" heading="Privy&#x27;s leftovers are cleaned up">/,
    );
    expect(html).toContain("The 2 items Privy left behind are gone as of this scan.");
    expect(html).not.toContain('variant="primary"');
    expect(html).not.toContain("<a ");
    expect(html).toMatch(/<s-button variant="secondary">Dismiss<\/s-button>/);
  });

  it("cleaned, several apps", () => {
    const html = render([
      ["Privy", 2, "CLEANED"],
      ["Yotpo", 1, "CLEANED"],
    ]);
    expect(html).toContain("2 apps&#x27; leftovers are cleaned up");
    expect(html).toContain("The 3 items they left behind are gone as of this scan.");
    expect(html).not.toContain("<li>");
  });

  it("no rendered variant says removed or uninstalled, or uses a dash", () => {
    const variants = [
      render([["Yotpo", 1]]),
      render([["Yotpo", 3]], { fullList: false }),
      render([
        ["A", 3],
        ["B", 2],
        ["C", 1],
        ["D", 1],
        ["E", 1],
        ["F", 1],
      ]),
      render([["Privy", 2, "CLEANED"]]),
      render([
        ["Privy", 2, "CLEANED"],
        ["Yotpo", 1, "CLEANED"],
      ]),
    ];
    for (const html of variants) {
      // Visible text plus the heading attribute (s-banner renders it).
      const visible = `${text(html)} ${[...html.matchAll(/heading="([^"]*)"/g)].map((m) => m[1]).join(" ")}`;
      expect(visible).not.toMatch(/remov|uninstall/i);
      expect(visible).not.toMatch(/[–—]/);
    }
  });
});
