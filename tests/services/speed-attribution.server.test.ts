/**
 * Tests for app/services/speed-attribution.server.ts (gc-wt3y): Lighthouse
 * result parsing, per-app attribution through the scanner's shared matcher,
 * password detection and median-of-3 selection.
 */
import { describe, it, expect } from "vitest";

import {
  attributeSpeedUrl,
  MAX_OTHER_THIRD_PARTY_ROWS,
  selectMedianRun,
  summarizeLighthouse,
} from "../../app/services/speed-attribution.server";
import {
  buildLighthouseResult,
  STORE_HOST,
  STORE_HOSTS,
  URLS,
} from "../fixtures/pagespeed-lighthouse";

const HOSTS = new Set(STORE_HOSTS);

describe("summarizeLighthouse: metrics", () => {
  it("reads score (0-100), LCP, TBT, CLS, FCP, Speed Index, bytes and request count", () => {
    const s = summarizeLighthouse(buildLighthouseResult(), STORE_HOSTS)!;
    expect(s.metrics).toEqual({
      score: 28,
      lcpMs: 14212,
      tbtMs: 9034,
      cls: 0.112,
      fcpMs: 4022,
      speedIndexMs: 11890,
      totalBytes: 8123456,
      // network-requests items (all of them, incl. the data: URI)
      requestCount: 10,
    });
    expect(s.finalUrl).toBe(URLS.document);
    expect(s.passwordProtected).toBe(false);
  });

  it("falls back to diagnostics.numRequests when network-requests is missing", () => {
    const lhr = buildLighthouseResult();
    delete (lhr.audits as Record<string, unknown>)["network-requests"];
    expect(summarizeLighthouse(lhr, STORE_HOSTS)!.metrics.requestCount).toBe(661);
  });

  it("keeps a null score (performance not computed) and missing audits as null", () => {
    const s = summarizeLighthouse(buildLighthouseResult({ score: null, audits: {} }), STORE_HOSTS)!;
    expect(s.metrics).toEqual({
      score: null,
      lcpMs: null,
      tbtMs: null,
      cls: null,
      fcpMs: null,
      speedIndexMs: null,
      totalBytes: null,
      requestCount: null,
    });
    expect(s.apps).toEqual([]);
    expect(s.otherThirdParty).toEqual([]);
  });

  it("returns null for something that is not a lighthouseResult", () => {
    expect(summarizeLighthouse(null, STORE_HOSTS)).toBeNull();
    expect(summarizeLighthouse({ categories: {} }, STORE_HOSTS)).toBeNull();
    expect(summarizeLighthouse("x", STORE_HOSTS)).toBeNull();
    expect(summarizeLighthouse([], STORE_HOSTS)).toBeNull();
  });

  it("tolerates malformed audit items without throwing", () => {
    const lhr = buildLighthouseResult({
      audits: {
        "network-requests": { details: { items: [null, 5, { url: 7 }, { url: URLS.klaviyo }] } },
        "third-party-summary": { details: { items: [{ subItems: { items: "nope" } }, {}] } },
        "bootup-time": { details: { items: "nope" } },
        "unused-javascript": { details: null },
      },
    });
    const s = summarizeLighthouse(lhr, STORE_HOSTS)!;
    // The one valid request: Klaviyo with no transfer size and no time -> no cost -> no row.
    expect(s.apps).toEqual([]);
    // Non-object items (null, 5) are not requests; the two objects are.
    expect(s.metrics.requestCount).toBe(2);
  });
});

describe("summarizeLighthouse: attribution", () => {
  const s = summarizeLighthouse(buildLighthouseResult(), STORE_HOSTS)!;

  it("groups an app's URLs (its CDN AND its app embed on cdn.shopify.com) into one row", () => {
    const klaviyo = s.apps.find((a) => a.name === "Klaviyo")!;
    expect(klaviyo).toEqual({
      name: "Klaviyo",
      // 3900.4 (summary, wins over bootup 3800) + 12.1 (image) + 210 (embed, bootup only)
      mainThreadMs: 4123,
      // 2050.1 + 0; the "Other resources" remainder row (50) is skipped
      blockingMs: 2050,
      transferBytes: 621000 + 1200000 + 30000,
      // 310500 / 621000
      unusedPct: 50,
      requestCount: 3,
    });
  });

  it("reports unused JavaScript per app (Recharge: 80% unused)", () => {
    expect(s.apps.find((a) => a.name === "Recharge")).toEqual({
      name: "Recharge",
      mainThreadMs: 640,
      blockingMs: 310,
      transferBytes: 169000,
      unusedPct: 80,
      requestCount: 1,
    });
  });

  it("sorts apps heaviest first by main-thread time", () => {
    expect(s.apps.map((a) => a.name)).toEqual(["Klaviyo", "Recharge"]);
  });

  it("groups unmatched third parties by host, with no unused % when none is reported", () => {
    expect(s.otherThirdParty).toEqual([
      {
        name: "fonts.gstatic.com",
        mainThreadMs: 0,
        blockingMs: 0,
        transferBytes: 48000,
        unusedPct: null,
        requestCount: 1,
      },
      {
        name: "fonts.googleapis.com",
        mainThreadMs: 0,
        blockingMs: 0,
        transferBytes: 2000,
        unusedPct: null,
        requestCount: 1,
      },
    ]);
  });

  it("keeps Shopify first party (store host + cdn.shopify.com) out of app rows but in totals", () => {
    const names = [...s.apps, ...s.otherThirdParty].map((r) => r.name);
    expect(names).not.toContain(STORE_HOST);
    expect(names).not.toContain("cdn.shopify.com");
    expect(names.some((n) => /shopify/i.test(n))).toBe(false);
    expect(s.firstParty).toEqual({
      // document 1500 + theme js 700 (bootup)
      mainThreadMs: 2200,
      // document + theme js + cdn.shopify.com theme css
      transferBytes: 52000 + 120000 + 80000,
    });
  });

  it("never double-counts a URL listed in both third-party-summary and bootup-time", () => {
    const lhr = buildLighthouseResult();
    const bootup = (
      lhr.audits as Record<string, { details: { items: Array<{ url: string; total: number }> } }>
    )["bootup-time"];
    bootup.details.items.find((i) => i.url === URLS.klaviyo)!.total = 99999;
    const klaviyo = summarizeLighthouse(lhr, STORE_HOSTS)!.apps.find((a) => a.name === "Klaviyo")!;
    expect(klaviyo.mainThreadMs).toBe(4123);
  });

  it("caps other third-party rows at MAX_OTHER_THIRD_PARTY_ROWS, keeping the heaviest", () => {
    const items = Array.from({ length: MAX_OTHER_THIRD_PARTY_ROWS + 5 }, (_, i) => ({
      url: `https://tracker${i}.example.net/t.js`,
      transferSize: 1000 * (i + 1),
    }));
    const lhr = buildLighthouseResult({
      audits: { "network-requests": { details: { items } } },
    });
    const rows = summarizeLighthouse(lhr, STORE_HOSTS)!.otherThirdParty;
    expect(rows).toHaveLength(MAX_OTHER_THIRD_PARTY_ROWS);
    expect(rows[0].name).toBe(`tracker${MAX_OTHER_THIRD_PARTY_ROWS + 4}.example.net`);
  });

  it("drops owners with no measurable cost", () => {
    const lhr = buildLighthouseResult({
      audits: {
        "network-requests": {
          details: { items: [{ url: "https://quiet.example.org/x.js", transferSize: 0 }] },
        },
      },
    });
    expect(summarizeLighthouse(lhr, STORE_HOSTS)!.otherThirdParty).toEqual([]);
  });
});

describe("attributeSpeedUrl (shared scanner matcher)", () => {
  it("names a known app by its CDN host", () => {
    expect(attributeSpeedUrl(URLS.klaviyo, HOSTS)).toEqual({ kind: "app", name: "Klaviyo" });
    expect(attributeSpeedUrl(URLS.recharge, HOSTS)).toEqual({ kind: "app", name: "Recharge" });
  });

  it("names a known app served from a Shopify host by its path (app embeds)", () => {
    expect(attributeSpeedUrl(URLS.klaviyoEmbed, HOSTS)).toEqual({ kind: "app", name: "Klaviyo" });
  });

  it("treats the store's own hosts and Shopify hosts as first party", () => {
    expect(attributeSpeedUrl(URLS.document, HOSTS)).toEqual({ kind: "first_party" });
    expect(attributeSpeedUrl(URLS.themeJs, HOSTS)).toEqual({ kind: "first_party" });
    expect(attributeSpeedUrl(URLS.shopifyCdn, HOSTS)).toEqual({ kind: "first_party" });
    expect(attributeSpeedUrl("https://monorail-edge.shopifysvc.com/v1/produce", HOSTS)).toEqual({
      kind: "first_party",
    });
    expect(attributeSpeedUrl("https://PAW-NATURALS.myshopify.com/x.js", HOSTS)).toEqual({
      kind: "first_party",
    });
  });

  it("does not treat a Shopify lookalike host as first party", () => {
    expect(attributeSpeedUrl("https://evilshopify.com/x.js", HOSTS)).toEqual({
      kind: "other",
      name: "evilshopify.com",
    });
  });

  it("returns an unmatched third party by host", () => {
    expect(attributeSpeedUrl(URLS.fontsCss, HOSTS)).toEqual({
      kind: "other",
      name: "fonts.googleapis.com",
    });
  });
});

describe("password page detection", () => {
  it.each([
    [`https://${STORE_HOST}/password`, true],
    [`https://${STORE_HOST}/password/`, true],
    [`https://${STORE_HOST}/password?ref=x`, true],
    [`https://${STORE_HOST}/`, false],
    [`https://${STORE_HOST}/products/password-safe`, false],
    [`https://${STORE_HOST}/pages/password`, false],
  ])("%s -> %s", (finalDisplayedUrl, expected) => {
    const s = summarizeLighthouse(buildLighthouseResult({ finalDisplayedUrl }), STORE_HOSTS)!;
    expect(s.passwordProtected).toBe(expected);
  });

  it("falls back to finalUrl (older Lighthouse) when finalDisplayedUrl is absent", () => {
    const lhr = buildLighthouseResult();
    delete lhr.finalDisplayedUrl;
    delete lhr.mainDocumentUrl;
    lhr.finalUrl = `https://${STORE_HOST}/password`;
    expect(summarizeLighthouse(lhr, STORE_HOSTS)!.passwordProtected).toBe(true);
  });

  it("is not password protected when no final URL is reported", () => {
    const lhr = buildLighthouseResult();
    delete lhr.finalDisplayedUrl;
    delete lhr.mainDocumentUrl;
    expect(summarizeLighthouse(lhr, STORE_HOSTS)!.passwordProtected).toBe(false);
  });
});

describe("selectMedianRun", () => {
  const run = (score: number | null, tag: string) => ({ metrics: { score }, tag });

  it("picks the middle score of 3 regardless of order", () => {
    expect(selectMedianRun([run(40, "a"), run(20, "b"), run(30, "c")])!.tag).toBe("c");
    expect(selectMedianRun([run(30, "a"), run(40, "b"), run(20, "c")])!.tag).toBe("a");
  });

  it("breaks ties by run order (stable)", () => {
    expect(selectMedianRun([run(30, "a"), run(30, "b"), run(30, "c")])!.tag).toBe("b");
    expect(selectMedianRun([run(30, "a"), run(20, "b"), run(30, "c")])!.tag).toBe("a");
    expect(selectMedianRun([run(20, "a"), run(30, "b"), run(20, "c")])!.tag).toBe("c");
  });

  it("with one failed run among 3 (2 results), picks the LOWER score", () => {
    expect(selectMedianRun([run(45, "a"), run(25, "b")])!.tag).toBe("b");
  });

  it("ignores runs with no score unless none has one", () => {
    expect(selectMedianRun([run(null, "a"), run(50, "b"), run(10, "c")])!.tag).toBe("c");
    expect(selectMedianRun([run(null, "a"), run(null, "b")])!.tag).toBe("a");
  });

  it("returns the only run, or null for none", () => {
    expect(selectMedianRun([run(70, "a")])!.tag).toBe("a");
    expect(selectMedianRun([])).toBeNull();
  });
});
