/**
 * Affected-app advisory (gc-14x5): the curated list
 * (app/data/app-incident-advisories.server.ts), its host matcher and review
 * dates, and the detector (detectAppIncidentAdvisories in the scan engine).
 *
 * The finding states two facts only: this app's code is in the theme, and a
 * public report names the app. Nothing here may ever claim the store was hit.
 */
import { FindingType, Severity } from "@prisma/client";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  activeAdvisories,
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
  formatAdvisoryDate,
  isAdvisoryActive,
  matchAdvisoryScriptHost,
  type AppIncidentAdvisory,
} from "../../app/data/app-incident-advisories.server";
import { APP_SIGNATURES } from "../../app/data/app-signatures.server";
import { matchMaliciousDomain } from "../../app/data/malicious-domains.server";
import { getFindingConfidence } from "../../app/lib/finding-classification";
import { dropAdvisoryUnknownScripts } from "../../app/services/app-incident-advisory.server";
import {
  ACTIVE_APP_OWN_FILE_TYPES,
  detectAppIncidentAdvisories,
  detectMaliciousScripts,
  dropActiveAppOwnFileFindings,
  enabledAppEmbedApps,
  isShopifyDomain,
  ORPHAN_GRADE_CORROBORATION_TYPES,
  scanThemeFiles,
} from "../../app/services/scan-engine.server";
import { bannerSourceUrl } from "../test-utils/advisory-banner";

const HULK = APP_INCIDENT_ADVISORIES[0];
const HOST = "productoption.hulkapps.com";
const TAG = `<script src="https://${HOST}/hulkcode.js" defer></script>`;
/** A day on which the Hulk entry is active. */
const ACTIVE = new Date("2026-10-20T12:00:00Z");
const DESCRIPTION =
  "Loads code from Hulk Product Options (productoption.hulkapps.com), an app named in a public report of shoppers being sent to a fake checkout page (10 October 2026)";

const file = (filename: string, content: string) => ({ filename, content });
const detect = (
  files: Array<{ filename: string; content: string }>,
  now: Date = ACTIVE,
  advisories?: ReadonlyArray<AppIncidentAdvisory>,
) => detectAppIncidentAdvisories(files, now, advisories);

/** A second, test-only entry (dependency injection: never in the real list). */
const OTHER: AppIncidentAdvisory = {
  appName: "Example Reviews",
  scriptHosts: ["widgets.example-reviews.test", "legacy.example-reviews.test"],
  embedHandles: [],
  incidentDate: "2026-09-01",
  sourceUrl: "https://example.test/report",
  summary: "named in a public report of a redirect on product pages",
  report: "a public report described a redirect on product pages",
  reportedByDeveloper: false,
  reviewBy: "2026-11-30",
};

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("APP_INCIDENT_ADVISORIES (list-level pins)", () => {
  it("holds exactly the verified entries, with the owner's fields", () => {
    expect(APP_INCIDENT_ADVISORIES).toEqual([
      {
        appName: "Hulk Product Options",
        scriptHosts: ["productoption.hulkapps.com"],
        embedHandles: ["shopify://apps/hulk-product-options/blocks/app-embed"],
        incidentDate: "2026-10-10",
        sourceUrl: "https://romanzipp.com/blog/shopify-hit-with-phishing-attack",
        summary: "named in a public report of shoppers being sent to a fake checkout page",
        report:
          "a public report described Hulk Product Options delivering code that sent shoppers to a fake checkout page on at least one store",
        reportedByDeveloper: false,
        reviewBy: "2027-01-08",
      },
      {
        appName: "Swym Wishlist Plus",
        scriptHosts: [],
        embedHandles: ["shopify://apps/wishlist-plus/blocks/wishlist-app-embed"],
        incidentDate: "2026-10-14",
        sourceUrl: "https://www.getswym.com/resources/security-response",
        summary:
          "whose developer reported that an unauthorized change to its configuration made a script load on some storefronts that could send shoppers to a fake checkout page",
        report:
          "Swym (Swym Wishlist Plus's developer) reported that an unauthorized change to its configuration made a script load on some storefronts that could send shoppers to a fake checkout page",
        reportedByDeveloper: true,
        reviewBy: "2027-01-12",
      },
      {
        appName: "Selleasy",
        scriptHosts: ["upsell-app.logbase.io"],
        embedHandles: ["shopify://apps/selleasy/blocks/app-embed"],
        incidentDate: "2026-10-13",
        sourceUrl: "https://www.logbase.io/selleasy/updates/incident-20261013",
        summary:
          "whose developer reported that an unauthorized script on some stores sent shoppers to a phishing page",
        report:
          "Logbase (Selleasy's developer) reported that an unauthorized script on some stores sent shoppers to a phishing page",
        reportedByDeveloper: true,
        reviewBy: "2027-01-11",
      },
      {
        appName: "17TRACK",
        scriptHosts: [],
        embedHandles: ["shopify://apps/17track/blocks/app-embed"],
        incidentDate: "2026-10-21",
        sourceUrl: "https://romanzipp.com/blog/shopify-hit-with-phishing-attack",
        summary:
          "listed as unconfirmed in a public report of shoppers being sent to fake checkout pages",
        report:
          "a public report of shoppers being sent to fake checkout pages listed 17TRACK as an unconfirmed affected app that had been removed from the Shopify App Store",
        reportedByDeveloper: false,
        reviewBy: "2027-01-19",
      },
    ]);
  });

  it.each(APP_INCIDENT_ADVISORIES)(
    "$appName: the review date is 90 days after the incident",
    (entry) => {
      const days =
        (Date.parse(`${entry.reviewBy}T00:00:00Z`) -
          Date.parse(`${entry.incidentDate}T00:00:00Z`)) /
        86_400_000;
      expect(days).toBe(90);
    },
  );

  it.each(APP_INCIDENT_ADVISORIES)("$appName: every field is well formed", (entry) => {
    expect(entry.appName.trim()).toBe(entry.appName);
    expect(entry.appName.length).toBeGreaterThan(0);
    // At least one match key: a script host or an app embed handle.
    expect(entry.scriptHosts.length + entry.embedHandles.length).toBeGreaterThan(0);
    for (const date of [entry.incidentDate, entry.reviewBy]) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A real calendar date (2026-02-30 would round-trip to something else).
      expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    }
    expect(entry.reviewBy > entry.incidentDate).toBe(true);
    expect(entry.sourceUrl).toMatch(/^https:\/\/[a-z0-9.-]+\/\S+$/);
  });

  it.each(APP_INCIDENT_ADVISORIES)(
    "$appName: script hosts are exact, lower-case hosts",
    (entry) => {
      for (const host of entry.scriptHosts) {
        expect(host).toBe(host.toLowerCase());
        expect(host).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
        // An app's own host, never a vendor base domain: at least three labels.
        expect(host.split(".").length).toBeGreaterThanOrEqual(3);
        // Never a host that belongs to Shopify or to the known-malicious list.
        expect(isShopifyDomain(host)).toBe(false);
        expect(matchMaliciousDomain(host)).toBeNull();
      }
      expect(new Set(entry.scriptHosts).size).toBe(entry.scriptHosts.length);
    },
  );

  it("never lists the HulkApps base domain (other HulkApps apps are not in the report)", () => {
    const hosts = APP_INCIDENT_ADVISORIES.flatMap((a) => a.scriptHosts);
    expect(hosts).not.toContain("hulkapps.com");
    expect(hosts).not.toContain("www.hulkapps.com");
  });

  it("no two entries share a script host or an app name", () => {
    const hosts = APP_INCIDENT_ADVISORIES.flatMap((a) => a.scriptHosts);
    expect(new Set(hosts).size).toBe(hosts.length);
    const names = APP_INCIDENT_ADVISORIES.map((a) => a.appName);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(APP_INCIDENT_ADVISORIES)(
    "$appName: merchant-facing text has no dashes, no trailing period and no claim about this store",
    (entry) => {
      for (const text of [entry.summary, entry.appName]) {
        expect(text).not.toMatch(/[—–]/);
        expect(text).not.toMatch(/\.$/);
      }
      expect(entry.summary).not.toMatch(/\byour\b/i);
      expect(entry.summary).not.toMatch(/hijack|compromised|malicious|infected|hacked/i);
    },
  );

  it("no advisory app name is also an app signature name (an advisory is not leftover code), except the allowlisted ones", () => {
    // app-removal detection and the active-app pass key on signature app names.
    // The advisory finding carries no appName (pinned by the detector tests),
    // and this keeps the two lists from being confused for one another.
    // Allowlisted: "Selleasy" is both the app's public name (merchant-facing,
    // so the advisory keeps it) and a leftover-code signature. Harmless while
    // the advisory finding carries no appName. "17TRACK" likewise (gc-dr7a):
    // its signature keys on the www.17track.net widget host, which the
    // advisory deliberately does not match.
    const ALLOWED_SHARED_NAMES = new Set(["Selleasy", "17TRACK"]);
    const signatureNames = new Set(APP_SIGNATURES.map((s) => s.appName));
    for (const entry of APP_INCIDENT_ADVISORIES) {
      if (ALLOWED_SHARED_NAMES.has(entry.appName)) continue;
      expect(signatureNames.has(entry.appName), entry.appName).toBe(false);
    }
    for (const name of ALLOWED_SHARED_NAMES) {
      expect(signatureNames.has(name), `${name} is still a signature name`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Review dates
// ---------------------------------------------------------------------------

describe("review dates", () => {
  it("FAILS when a list entry's reviewBy date has passed: renew or remove the entry", () => {
    const now = new Date();
    for (const entry of APP_INCIDENT_ADVISORIES) {
      expect(
        isAdvisoryActive(entry, now),
        `The "${entry.appName}" advisory passed its review date (${entry.reviewBy}) and has ` +
          `stopped firing. Re-read ${entry.sourceUrl} and check for a vendor statement, then ` +
          `either renew the entry (set a new reviewBy in ` +
          `app/data/app-incident-advisories.server.ts) or remove it.`,
      ).toBe(true);
    }
  });

  it.each([
    ["long before", "2026-10-10T00:00:00Z", true],
    ["the day before, last instant", "2027-01-07T23:59:59.999Z", true],
    ["the day of, first instant", "2027-01-08T00:00:00.000Z", true],
    ["the day of, noon", "2027-01-08T12:00:00Z", true],
    ["the day of, last instant", "2027-01-08T23:59:59.999Z", true],
    ["the day after, first instant", "2027-01-09T00:00:00.000Z", false],
    ["the day after, noon", "2027-01-09T12:00:00Z", false],
    ["a year later", "2028-01-08T00:00:00Z", false],
  ])("isAdvisoryActive %s (%s) is %s", (_label, iso, expected) => {
    expect(isAdvisoryActive(HULK, new Date(iso))).toBe(expected);
  });

  it("compares in UTC, whatever the offset the instant was written in", () => {
    // 2027-01-08 20:00 in UTC-5 is already 2027-01-09 01:00 UTC: expired.
    expect(isAdvisoryActive(HULK, new Date("2027-01-08T20:00:00-05:00"))).toBe(false);
    // 2027-01-09 05:00 in UTC+9 is still 2027-01-08 20:00 UTC: active.
    expect(isAdvisoryActive(HULK, new Date("2027-01-09T05:00:00+09:00"))).toBe(true);
  });

  it.each([
    ["the day before", "2027-01-07T12:00:00Z", 1],
    ["the day of", "2027-01-08T12:00:00Z", 1],
    ["the day after", "2027-01-09T12:00:00Z", 0],
  ])("the detector on %s (%s) emits %i finding(s)", (_label, iso, count) => {
    expect(detect([file("layout/theme.liquid", TAG)], new Date(iso))).toHaveLength(count);
  });

  it("an expired entry emits nothing while an active one beside it still fires", () => {
    const files = [
      file(
        "layout/theme.liquid",
        `${TAG}\n<script src="https://widgets.example-reviews.test/w.js">`,
      ),
    ];
    // OTHER expires 2026-11-30; Hulk is active until 2027-01-08.
    const found = detect(files, new Date("2026-12-15T00:00:00Z"), [HULK, OTHER]);
    expect(found.map((f) => f.description)).toEqual([DESCRIPTION]);
  });
});

// ---------------------------------------------------------------------------
// Host matching
// ---------------------------------------------------------------------------

describe("matchAdvisoryScriptHost", () => {
  it.each([
    "productoption.hulkapps.com",
    "PRODUCTOPTION.HULKAPPS.COM",
    "ProductOption.HulkApps.com",
    "cdn.productoption.hulkapps.com",
    "CDN.ProductOption.HulkApps.Com",
    "a.b.productoption.hulkapps.com",
    "productoption.hulkapps.com.",
  ])("matches %s", (host) => {
    expect(matchAdvisoryScriptHost(host)).toEqual({ advisory: HULK, scriptHost: HOST });
  });

  it.each([
    "master-motivator.hulkapps.com",
    "hulkapps.com",
    "www.hulkapps.com",
    "notproductoption.hulkapps.com",
    "productoption.hulkapps.com.example.com",
    "productoption-hulkapps.com",
    "productoption.hulkapps.co",
    "productoption.hulkapps.com.evil.top",
    "xproductoption.hulkapps.com",
    "hulkapps.productoption.com",
    "productoption.hulkapps",
    "",
    "cdn.shopify.com",
  ])("never matches %s", (host) => {
    expect(matchAdvisoryScriptHost(host)).toBeNull();
  });

  it("matches only the entries it is given (review dates are the caller's job)", () => {
    expect(matchAdvisoryScriptHost(HOST, [])).toBeNull();
    expect(matchAdvisoryScriptHost(HOST, [OTHER])).toBeNull();
    expect(matchAdvisoryScriptHost("legacy.example-reviews.test", [HULK, OTHER])).toEqual({
      advisory: OTHER,
      scriptHost: "legacy.example-reviews.test",
    });
  });
});

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

describe("advisoryDescription", () => {
  it("is the owner's sentence, built from the entry fields", () => {
    expect(advisoryDescription({ advisory: HULK, scriptHost: HOST })).toBe(DESCRIPTION);
  });

  it("has no trailing period and no dashes", () => {
    for (const advisory of [HULK, OTHER]) {
      const text = advisoryDescription({ advisory, scriptHost: advisory.scriptHosts[0] });
      expect(text).not.toMatch(/\.$/);
      expect(text).not.toMatch(/[—–]/);
    }
  });

  it("never says or implies the store itself was affected", () => {
    const text = advisoryDescription({ advisory: HULK, scriptHost: HOST });
    expect(text).not.toMatch(/hijack|compromised|malicious|infected|hacked|stolen/i);
    expect(text).not.toMatch(/your (store|checkout|theme|shoppers|customers)/i);
    expect(text).not.toMatch(/uninstalled|removed|leftover|left behind/i);
  });

  it("names the listed host that matched, not the subdomain found in the theme", () => {
    const [finding] = detect([
      file("layout/theme.liquid", `<script src="https://cdn.${HOST}/x.js"></script>`),
    ]);
    expect(finding.description).toBe(DESCRIPTION);
  });

  it.each([
    ["2026-10-10", "10 October 2026"],
    ["2026-01-01", "1 January 2026"],
    ["2027-12-31", "31 December 2027"],
    ["2026-02-09", "9 February 2026"],
  ])("formatAdvisoryDate(%s) is %s", (iso, text) => {
    expect(formatAdvisoryDate(iso)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

describe("detectAppIncidentAdvisories", () => {
  it("flags a script src: one HIGH finding, anchored to the line, no app name", () => {
    const found = detect([file("layout/theme.liquid", `<html>\n<head>\n  ${TAG}\n</head>`)]);
    expect(found).toEqual([
      {
        filename: "layout/theme.liquid",
        lineNumber: 3,
        codeSnippet: `  ${TAG}`,
        findingType: FindingType.APP_INCIDENT_ADVISORY,
        severity: Severity.HIGH,
        appName: undefined,
        description: DESCRIPTION,
      },
    ]);
  });

  describe("with the clock pinned (the defaults read the real list and `new Date()`)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(ACTIVE);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("uses the real list and the current date by default", () => {
      expect(detectAppIncidentAdvisories([file("layout/theme.liquid", TAG)])).toHaveLength(1);
      vi.setSystemTime(new Date("2027-01-09T00:00:00Z"));
      expect(detectAppIncidentAdvisories([file("layout/theme.liquid", TAG)])).toEqual([]);
    });
  });

  // ---- What DOES count: a script tag's src, or a script_tag filter --------
  describe("reference forms that load the script (each fires)", () => {
    it.each([
      ["double-quoted src", `<script src="https://${HOST}/hulkcode.js"></script>`],
      ["single-quoted src", `<script src='https://${HOST}/hulkcode.js'></script>`],
      ["unquoted src", `<script src=https://${HOST}/hulkcode.js></script>`],
      ["protocol-relative src", `<script src="//${HOST}/hulkcode.js"></script>`],
      ["http src", `<script src="http://${HOST}/hulkcode.js"></script>`],
      ["upper-case host", `<script src="https://PRODUCTOPTION.HULKAPPS.COM/hulkcode.js"></script>`],
      ["upper-case tag and attribute", `<SCRIPT SRC="https://${HOST}/hulkcode.js"></SCRIPT>`],
      ["subdomain of the host", `<script src="https://cdn.${HOST}/hulkcode.js"></script>`],
      [
        "src after other attributes",
        `<script async defer type="text/javascript" src="https://${HOST}/hulkcode.js"></script>`,
      ],
      [
        "src before other attributes",
        `<script src="https://${HOST}/hulkcode.js" async data-x="1"></script>`,
      ],
      ["spaces around =", `<script src = "https://${HOST}/hulkcode.js"></script>`],
      ["trailing FQDN dot", `<script src="https://${HOST}./hulkcode.js"></script>`],
      ["port", `<script src="https://${HOST}:443/hulkcode.js"></script>`],
      ["query string", `<script src="https://${HOST}/hulkcode.js?shop=x.myshopify.com"></script>`],
      ["backslash-escaped slashes", `<script src="https:\\/\\/${HOST}\\/hulkcode.js"></script>`],
      ["entity-encoded slashes", `<script src="https:&#47;&#47;${HOST}&#47;hulkcode.js"></script>`],
      ["hex-entity slashes", `<script src="https:&#x2F;&#x2F;${HOST}&#x2F;hulkcode.js"></script>`],
      [
        "Liquid inside the tag",
        `<script src="https://${HOST}/hulkcode.js?v={{ 'now' | date: '%s' }}" {% if x %}defer{% endif %}></script>`,
      ],
      ["script_tag filter, single quotes", `{{ 'https://${HOST}/hulkcode.js' | script_tag }}`],
      ["script_tag filter, double quotes", `{{ "https://${HOST}/hulkcode.js" | script_tag }}`],
      ["script_tag filter, protocol-relative", `{{ '//${HOST}/hulkcode.js' | script_tag }}`],
      ["script_tag filter, no spaces", `{{'https://${HOST}/hulkcode.js'|script_tag}}`],
      [
        "script_tag filter, whitespace control",
        `{{- 'https://${HOST}/hulkcode.js' | script_tag -}}`,
      ],
      ["script_tag filter across lines", `{{ 'https://${HOST}/hulkcode.js'\n  | script_tag }}`],
    ])("%s", (_label, content) => {
      const found = detect([file("layout/theme.liquid", content)]);
      expect(found).toHaveLength(1);
      expect(found[0].description).toBe(DESCRIPTION);
      expect(found[0].codeSnippet.toLowerCase()).toContain(HOST);
    });

    it("a tag split across lines fires, anchored to the line that holds the host", () => {
      const content = [
        "<head>",
        "<script",
        "  async",
        `  src="https://${HOST}/hulkcode.js"`,
        "></script>",
      ].join("\n");
      const found = detect([file("layout/theme.liquid", content)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(4);
      expect(found[0].codeSnippet).toBe(`  src="https://${HOST}/hulkcode.js"`);
    });

    it.each([
      "layout/theme.liquid",
      "templates/product.liquid",
      "templates/customers/login.liquid",
      "sections/main-product.liquid",
      "snippets/hulk.liquid",
      "blocks/options.liquid",
    ])("in %s (Liquid the storefront renders as HTML)", (filename) => {
      expect(detect([file(filename, TAG)])).toHaveLength(1);
    });
  });

  // ---- What does NOT count ------------------------------------------------
  describe("reference forms that do not load the script (none fires)", () => {
    it.each([
      ["a link", `<a href="https://${HOST}/">Options</a>`],
      ["an image", `<img src="https://${HOST}/logo.png">`],
      ["an iframe", `<iframe src="https://${HOST}/widget"></iframe>`],
      ["a preconnect hint", `<link rel="preconnect" href="https://${HOST}">`],
      ["a dns-prefetch hint", `<link rel="dns-prefetch" href="//${HOST}">`],
      ["a preload hint", `<link rel="preload" as="script" href="https://${HOST}/hulkcode.js">`],
      ["a stylesheet", `<link rel="stylesheet" href="https://${HOST}/hulk.css">`],
      ["a stylesheet_tag filter", `{{ 'https://${HOST}/hulk.css' | stylesheet_tag }}`],
      ["CSS url()", `<style>.x{background:url(https://${HOST}/a.png)}</style>`],
      ["a data-src attribute", `<script data-src="https://${HOST}/hulkcode.js"></script>`],
      [
        "a script tag with no src that mentions the URL",
        `<script>var unused = "https://${HOST}/hulkcode.js";</script>`,
      ],
      ["an inline fetch", `<script>fetch("https://${HOST}/api/options");</script>`],
      [
        "a non-script tag named like one",
        `<scripted src="https://${HOST}/hulkcode.js"></scripted>`,
      ],
      ["the host in prose", `<p>We use ${HOST} for options</p>`],
      ["the host as a query value", `<a href="/pages/x?host=${HOST}">x</a>`],
      [
        "the host as a path segment of another URL",
        `<script src="https://cdn.example.com//${HOST}/a.js"></script>`,
      ],
      [
        "a relative src that only mentions the host",
        `<script src="/apps/proxy?u=https://${HOST}/hulkcode.js"></script>`,
      ],
      [
        "a Liquid string assigned, never printed as a script",
        `{% assign u = 'https://${HOST}/hulkcode.js' %}`,
      ],
      ["a Liquid string with another filter", `{{ 'https://${HOST}/hulkcode.js' | escape }}`],
      [
        "script_tag applied to something else on the line",
        `{{ 'https://${HOST}/hulkcode.js' | escape }} {{ 'theme.js' | asset_url | script_tag }}`,
      ],
      [
        "sibling HulkApps app",
        `<script src="https://master-motivator.hulkapps.com/a.js"></script>`,
      ],
      ["vendor base domain", `<script src="https://hulkapps.com/a.js"></script>`],
      ["lookalike prefix", `<script src="https://notproductoption.hulkapps.com/a.js"></script>`],
      [
        "host used as a prefix of another domain",
        `<script src="https://productoption.hulkapps.com.example.com/a.js"></script>`,
      ],
      ["the app's name without its host", `<div class="hulkapps_product_options"></div>`],
    ])("%s", (_label, content) => {
      expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
    });

    it.each([
      ["{% comment %} block", `{% comment %}${TAG}{% endcomment %}`],
      ["{%- comment -%} block over lines", `{%- comment -%}\n${TAG}\n{%- endcomment -%}`],
      ["inline {% # %} comment", `{% # ${TAG} %}`],
      [
        "inline {%- # -%} comment with a script_tag filter",
        `{%- # {{ 'https://${HOST}/hulkcode.js' | script_tag }} -%}`,
      ],
      ["{% raw %} block", `{% raw %}${TAG}{% endraw %}`],
      [
        "{% raw %} block with a script_tag filter",
        `{% raw %}{{ 'https://${HOST}/hulkcode.js' | script_tag }}{% endraw %}`,
      ],
      [
        "{% schema %} default",
        `{% schema %}{"settings":[{"type":"html","id":"x","default":"<script src=\\"https://${HOST}/hulkcode.js\\"></script>"}]}{% endschema %}`,
      ],
      ["{% doc %} block", `{% doc %}\n  ${TAG}\n{% enddoc %}`],
      [
        "a comment statement inside {% liquid %}",
        `{% liquid\n  comment\n    echo '${TAG}'\n  endcomment\n%}`,
      ],
      ["HTML comment, one line", `<!-- ${TAG} -->`],
      ["HTML comment over lines", `<!--\n  removed 2026-10-11\n  ${TAG}\n-->`],
      [
        "JS line comment in an inline script",
        `<script>\n  // document.write('${TAG}');\n</script>`,
      ],
      [
        "JS block comment in an inline script",
        `<script>\n  /* var old = '<script src="https://${HOST}/hulkcode.js">'; */\n</script>`,
      ],
      ["an unterminated {% comment %} (Liquid would reject the file)", `{% comment %}\n${TAG}`],
    ])("inside %s", (_label, content) => {
      expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
    });

    it.each([
      [
        "templates/product.json",
        `{"custom_liquid":"<script src='https://${HOST}/x.js'></script>"}`,
      ],
      [
        "templates/index.json",
        `{"html":"<script src=\\"https:\\/\\/${HOST}\\/hulkcode.js\\"><\\/script>"}`,
      ],
      ["sections/header-group.json", `{"html":"<script src='https://${HOST}/x.js'></script>"}`],
      [
        "config/settings_data.json",
        `{"current":{"custom_html":"<script src='https://${HOST}/x.js'></script>"}}`,
      ],
      ["config/settings_schema.json", `[{"name":"<script src='https://${HOST}/x.js'></script>"}]`],
      ["locales/en.default.json", `{"x_html":"<script src='https://${HOST}/x.js'></script>"}`],
      ["assets/theme.js", `document.write('<script src="https://${HOST}/hulkcode.js"></script>');`],
      ["assets/theme.js", `//${HOST}/hulkcode.js`],
      ["assets/theme.js", `var unused = "https://${HOST}/hulkcode.js";`],
      ["assets/custom.mjs", `import("https://${HOST}/hulkcode.js");`],
      ["assets/theme.js.liquid", TAG],
      ["assets/theme.css", `.x{background:url(https://${HOST}/a.png)}`],
      ["assets/snippet.liquid", TAG],
      ["README.md", TAG],
      ["snippets/hulk.txt", TAG],
    ])("in %s (not Liquid the storefront renders as HTML)", (filename, content) => {
      expect(detect([file(filename, content)])).toEqual([]);
    });

    it("control: each of those wrappers hides only what is inside it", () => {
      const content = [
        `{% comment %}${TAG}{% endcomment %}`,
        `<!-- ${TAG} -->`,
        `{% raw %}${TAG}{% endraw %}`,
        TAG,
      ].join("\n");
      const found = detect([file("layout/theme.liquid", content)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(4);
      expect(found[0].codeSnippet).toBe(TAG);
    });

    it("live code beside a comment on the same line still counts, and the snippet shows the live copy", () => {
      const filler = "x".repeat(400);
      const line = `<!-- <script src="https://${HOST}/old.js"></script> -->${filler}<script src="https://${HOST}/hulkcode.js"></script>`;
      const [finding] = detect([file("layout/theme.liquid", line)]);
      expect(finding.lineNumber).toBe(1);
      expect(finding.codeSnippet).toContain("hulkcode.js");
      expect(finding.codeSnippet).not.toContain("old.js");
    });

    it("the malicious detector is unchanged: it still reports ANY reference to a listed domain", () => {
      for (const content of [
        `<a href="https://jsdeliver.cloud/x">x</a>`,
        `{% # https://jsdeliver.cloud/x.js %}`,
        `<img src="https://jsdeliver.cloud/x.png">`,
      ]) {
        expect(detectMaliciousScripts(file("layout/theme.liquid", content)), content).toHaveLength(
          1,
        );
      }
      expect(
        detectMaliciousScripts(
          file("templates/index.json", `{"x":"https://jsdeliver.cloud/x.js"}`),
        ),
      ).toHaveLength(1);
    });
  });

  describe("one finding per list entry per scan", () => {
    it("many loads in one file give ONE finding, on the first", () => {
      const content = [
        "<head>",
        TAG,
        TAG,
        `{{ 'https://${HOST}/hulkcode.js' | script_tag }}`,
        TAG,
      ].join("\n");
      const found = detect([file("layout/theme.liquid", content)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(2);
    });

    it("a script_tag filter before a script tag: anchored to whichever comes first in the file", () => {
      const content = [`{{ 'https://${HOST}/a.js' | script_tag }}`, TAG].join("\n");
      expect(detect([file("layout/theme.liquid", content)])[0].lineNumber).toBe(1);
      const reversed = [TAG, `{{ 'https://${HOST}/a.js' | script_tag }}`].join("\n");
      expect(detect([file("layout/theme.liquid", reversed)])[0].lineNumber).toBe(1);
    });

    it("two loads on one line give ONE finding", () => {
      expect(detect([file("layout/theme.liquid", `${TAG}${TAG}`)])).toHaveLength(1);
    });

    it("a non-loading mention earlier in the file is passed over for the real load", () => {
      const content = [
        `<a href="https://${HOST}/">docs</a>`,
        `<link rel="preconnect" href="https://${HOST}">`,
        TAG,
      ].join("\n");
      const found = detect([file("layout/theme.liquid", content)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(3);
    });

    it("two files give ONE finding, anchored to the first file in scan order", () => {
      const files = [
        file("layout/theme.liquid", `<p>nothing</p>\n${TAG}`),
        file("sections/main-product.liquid", TAG),
        file("snippets/options.liquid", TAG),
      ];
      const found = detect(files);
      expect(found).toHaveLength(1);
      expect(found[0].filename).toBe("layout/theme.liquid");
      expect(found[0].lineNumber).toBe(2);

      const reversed = detect([...files].reverse());
      expect(reversed).toHaveLength(1);
      expect(reversed[0].filename).toBe("snippets/options.liquid");
      expect(reversed[0].lineNumber).toBe(1);
    });

    it("a file whose only reference is commented out, or is not a rendered file, is passed over for the next", () => {
      const found = detect([
        file("layout/theme.liquid", `<!-- ${TAG} -->`),
        file("assets/theme.js", `document.write('${TAG}')`),
        file("snippets/options.liquid", `\n\n${TAG}`),
      ]);
      expect(found).toHaveLength(1);
      expect(found[0].filename).toBe("snippets/options.liquid");
      expect(found[0].lineNumber).toBe(3);
    });

    it("two entries give two findings, one each, in list order", () => {
      const files = [
        file(
          "layout/theme.liquid",
          `<script src="https://widgets.example-reviews.test/w.js"></script>`,
        ),
        file(
          "sections/product.liquid",
          `${TAG}\n<script src="https://legacy.example-reviews.test/w.js"></script>`,
        ),
      ];
      const found = detect(files, ACTIVE, [HULK, OTHER]);
      expect(found.map((f) => [f.filename, f.lineNumber, f.description])).toEqual([
        ["sections/product.liquid", 1, DESCRIPTION],
        [
          "layout/theme.liquid",
          1,
          "Loads code from Example Reviews (widgets.example-reviews.test), an app named in a public report of a redirect on product pages (1 September 2026)",
        ],
      ]);
    });

    it("two entries on the same line give two findings", () => {
      const line = `${TAG}<script src="https://widgets.example-reviews.test/w.js"></script>`;
      const found = detect([file("layout/theme.liquid", line)], ACTIVE, [HULK, OTHER]);
      expect(found).toHaveLength(2);
      expect(found.every((f) => f.lineNumber === 1)).toBe(true);
    });

    it("an entry with two script hosts still gives one finding", () => {
      const content = [
        `<script src="https://legacy.example-reviews.test/w.js"></script>`,
        `<script src="https://widgets.example-reviews.test/w.js"></script>`,
      ].join("\n");
      const found = detect([file("layout/theme.liquid", content)], ACTIVE, [OTHER]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(1);
      expect(found[0].description).toContain("(legacy.example-reviews.test)");
    });
  });

  describe("nothing to report", () => {
    it("no reference: nothing", () => {
      expect(detect([file("layout/theme.liquid", "<html><head></head></html>")])).toEqual([]);
    });

    it("no files, or an empty list: nothing", () => {
      expect(detect([])).toEqual([]);
      expect(detect([file("layout/theme.liquid", TAG)], ACTIVE, [])).toEqual([]);
    });

    it("an empty file: nothing", () => {
      expect(detect([file("layout/theme.liquid", "")])).toEqual([]);
    });

    it("an unterminated script tag: nothing (there is no complete tag)", () => {
      expect(
        detect([file("layout/theme.liquid", `<script src="https://${HOST}/hulkcode.js"`)]),
      ).toEqual([]);
    });
  });

  describe("snippet", () => {
    it("starts 40 characters before the host on a line with a long lead, so the host is always in view", () => {
      const line = `<div class="a-very-long-wrapper-class-name another-class"><script async src="https://${HOST}/hulkcode.js"></script></div>`;
      const [finding] = detect([file("layout/theme.liquid", line)]);
      expect(finding.codeSnippet).toBe(line.slice(line.indexOf(HOST) - 40));
      expect(finding.codeSnippet.slice(0, 80)).toContain(HOST);
    });

    it("is the same window the malicious detector would store for that line", () => {
      const lead = "x".repeat(120);
      const advisory = detect([
        file("layout/theme.liquid", `${lead}<script src="https://${HOST}/a.js"></script>`),
      ])[0];
      const malicious = detectMaliciousScripts(
        file("layout/theme.liquid", `${lead}<script src="https://jsdeliver.cloud/a.js"></script>`),
      )[0];
      const window = `${"x".repeat(19)}<script src="https://`;
      expect(advisory.codeSnippet.slice(0, 40)).toBe(window);
      expect(malicious.codeSnippet.slice(0, 40)).toBe(window);
    });

    it("is the flagged line, not its neighbours", () => {
      const [finding] = detect([
        file("layout/theme.liquid", `<p>before</p>\n${TAG}\n<p>after</p>`),
      ]);
      expect(finding.codeSnippet).toBe(TAG);
    });

    it("on a long minified line is a 300-character window that shows the host", () => {
      const line = `${"<i>a</i>".repeat(700)}<script src="https://${HOST}/hulkcode.js"></script>${"<i>b</i>".repeat(700)}`;
      const [finding] = detect([file("layout/theme.liquid", line)]);
      expect(finding.codeSnippet).toHaveLength(300);
      expect(finding.codeSnippet).toContain(HOST);
    });

    it("keeps the theme's own casing", () => {
      const line = `<script src="https://ProductOption.HulkApps.com/hulkcode.js"></script>`;
      const [finding] = detect([file("layout/theme.liquid", line)]);
      expect(finding.codeSnippet).toBe(line);
    });

    it("handles CRLF line endings (the line number is still right)", () => {
      const [finding] = detect([file("layout/theme.liquid", `<head>\r\n${TAG}\r\n</head>`)]);
      expect(finding.lineNumber).toBe(2);
      expect(finding.codeSnippet).toContain(TAG);
    });
  });

  it("stays linear on a 1 MB file of unterminated tags and quotes", () => {
    const big = `${`<script src='${HOST} `.repeat(30_000)}\n${TAG}`;
    expect(big.length).toBeGreaterThan(1_000_000);
    const started = Date.now();
    detect([file("layout/theme.liquid", big)]);
    detect([file("layout/theme.liquid", `${"'x' | ".repeat(150_000)}${TAG}`)]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not mutate its inputs", () => {
    const files = [file("layout/theme.liquid", TAG)];
    const before = JSON.stringify(files);
    const list = [HULK, OTHER];
    detect(files, ACTIVE, list);
    expect(JSON.stringify(files)).toBe(before);
    expect(list).toEqual([HULK, OTHER]);
  });
});

// ---------------------------------------------------------------------------
// Round 4: every doubt resolves toward NOT reporting
// ---------------------------------------------------------------------------

describe("a commented-out script tag is never a load, whatever comes before it", () => {
  const COMMENTED = `<!-- <script src='https://${HOST}/hulkcode.js'></script> -->`;
  /** Each construct used to make the comment scanner give up for the rest of the file. */
  const BEFORE: Array<[string, string]> = [
    [
      'a <script type="text/template"> containing an HTML comment',
      `<script type="text/template"><!-- tpl --><div>{{ x }}</div></script>`,
    ],
    ["a JS string containing <!--", `<script>var marker = "<!--";</script>`],
    [
      "a JSON-LD value containing <!--",
      `<script type="application/ld+json">{"description":"see <!-- note"}</script>`,
    ],
    ["a legacy <script><!-- ... //--></script>", `<script><!--\nvar legacy = 1;\n//--></script>`],
    ["an unterminated {{", `<p>{{ product.title </p>`],
    ["a stray quote in a tag", `<img alt="a "quoted" name"" src="/x.png">`],
    ["a bare <![CDATA[", `<![CDATA[ data`],
  ];

  it.each(BEFORE)("after %s: the commented-out tag does not fire", (_label, construct) => {
    expect(detect([file("layout/theme.liquid", `${construct}\n${COMMENTED}`)])).toEqual([]);
  });

  it.each(BEFORE)("control, after %s: a real script tag STILL fires", (_label, construct) => {
    const found = detect([file("layout/theme.liquid", `${construct}\n${TAG}`)]);
    expect(found).toHaveLength(1);
    expect(found[0].lineNumber).toBe(construct.split("\n").length + 1);
    expect(found[0].codeSnippet).toBe(TAG);
  });

  it.each(BEFORE)(
    "control, after %s: commented copy first, real tag after it -> anchored to the real one",
    (_label, construct) => {
      const found = detect([file("layout/theme.liquid", `${construct}\n${COMMENTED}\n${TAG}`)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(construct.split("\n").length + 2);
    },
  );

  it("inside a script block: a //-commented document.write after a template literal with ${ does not fire", () => {
    const content = [
      "<script>",
      "  const greeting = `hello ${name}`;",
      `  // document.write('<script src="https://${HOST}/hulkcode.js">');`,
      "</script>",
    ].join("\n");
    expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
    // Control: a real tag after that block still fires.
    expect(detect([file("layout/theme.liquid", `${content}\n${TAG}`)])).toHaveLength(1);
  });

  it("an unterminated HTML comment hides the rest of the file (was: reported)", () => {
    expect(detect([file("layout/theme.liquid", `<!-- oops\n${TAG}`)])).toEqual([]);
    // The next file is still read.
    expect(
      detect([file("layout/theme.liquid", `<!-- oops\n${TAG}`), file("snippets/a.liquid", TAG)]),
    ).toMatchObject([{ filename: "snippets/a.liquid" }]);
  });

  it("a script_tag filter inside an HTML comment does not fire either", () => {
    const filter = `{{ 'https://${HOST}/hulkcode.js' | script_tag }}`;
    expect(detect([file("layout/theme.liquid", `<!-- ${filter} -->`)])).toEqual([]);
    expect(detect([file("layout/theme.liquid", `<!-- x -->\n${filter}`)])).toHaveLength(1);
  });

  it("the malicious detector keeps failing toward reporting (unchanged)", () => {
    const content = `<script>var marker = "<!--";</script>\n<!-- <script src="https://cdn.polyfill.io/v3/polyfill.min.js"></script> -->`;
    expect(detectMaliciousScripts(file("layout/theme.liquid", content))).toHaveLength(1);
  });
});

describe("small precision gaps closed (round 4)", () => {
  it("`src=` inside another attribute's quoted value is not the tag's src", () => {
    expect(
      detect([
        file(
          "layout/theme.liquid",
          `<script data-x="a src=https://${HOST}/x.js" src="/local.js"></script>`,
        ),
      ]),
    ).toEqual([]);
    expect(
      detect([
        file("layout/theme.liquid", `<script data-x='src="https://${HOST}/x.js"'></script>`),
      ]),
    ).toEqual([]);
  });

  it("control: the real src still wins beside such an attribute, and the first src is the one used", () => {
    expect(
      detect([
        file(
          "layout/theme.liquid",
          `<script data-x="src=/local.js" src="https://${HOST}/x.js"></script>`,
        ),
      ]),
    ).toHaveLength(1);
    // HTML keeps the FIRST src attribute.
    expect(
      detect([
        file("layout/theme.liquid", `<script src="/local.js" src="https://${HOST}/x.js"></script>`),
      ]),
    ).toEqual([]);
  });

  it("a `>` inside a quoted attribute value does not end the tag", () => {
    expect(
      detect([
        file(
          "layout/theme.liquid",
          `<script data-note="a > b" src="https://${HOST}/x.js"></script>`,
        ),
      ]),
    ).toHaveLength(1);
  });

  it.each([
    `https://${HOST}%2eevil.com/x.js`,
    `https://${HOST}%2Eevil.com/x.js`,
    `//${HOST}%2eevil.com/x.js`,
    `https://${HOST}evil.com/x.js`,
    `https://${HOST}@evil.com/x.js`,
  ])("a host that only STARTS like the listed one does not match: %s", (url) => {
    expect(detect([file("layout/theme.liquid", `<script src="${url}"></script>`)])).toEqual([]);
    expect(detect([file("layout/theme.liquid", `{{ '${url}' | script_tag }}`)])).toEqual([]);
  });

  it.each([
    `https://${HOST}`,
    `https://${HOST}/`,
    `https://${HOST}:8443/x.js`,
    `https://${HOST}?v=1`,
    `https://${HOST}#frag`,
    `https://user@${HOST}/x.js`,
  ])("control: the host followed by a URL delimiter still matches: %s", (url) => {
    expect(detect([file("layout/theme.liquid", `<script src="${url}"></script>`)])).toHaveLength(1);
  });

  it.each([
    ["<noscript>", `<noscript>${TAG}</noscript>`],
    ["<template>", `<template id="t">${TAG}</template>`],
    ["<textarea>", `<textarea>${TAG}</textarea>`],
    ['the body of <script type="text/template">', `<script type="text/template">${TAG}</script>`],
    ["the body of an inline <script>", `<script>var html = '${TAG}';</script>`],
    ["<style>", `<style>/* ${TAG} */</style>`],
    ["<xmp>", `<xmp>${TAG}</xmp>`],
  ])("a script tag inside %s does not fire", (_label, content) => {
    expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
  });

  it.each([
    ["<noscript>", `<noscript><img src="/px.gif"></noscript>`],
    ["<template>", `<template id="t"><p>x</p></template>`],
    ["<textarea>", `<textarea>hello</textarea>`],
    ['<script type="text/template">', `<script type="text/template"><p>x</p></script>`],
    ["<style>", `<style>.a{}</style>`],
    ["upper-case <NOSCRIPT>", `<NOSCRIPT>x</NOSCRIPT>`],
  ])("control: a real script tag AFTER a closed %s still fires", (_label, before) => {
    expect(detect([file("layout/theme.liquid", `${before}\n${TAG}`)])).toHaveLength(1);
  });

  it("an element that is never closed hides the rest of the file", () => {
    expect(detect([file("layout/theme.liquid", `<noscript>\n${TAG}`)])).toEqual([]);
    expect(detect([file("layout/theme.liquid", `<script>var a = 1;\n${TAG}`)])).toEqual([]);
  });

  it("a script tag whose own body is never closed still counts (the tag itself is complete)", () => {
    expect(
      detect([file("layout/theme.liquid", `<script src="https://${HOST}/x.js">`)]),
    ).toHaveLength(1);
  });

  it("`<script/src=...>` is a script tag with a src (HTML treats `/` as a separator)", () => {
    expect(
      detect([file("layout/theme.liquid", `<script/src="https://${HOST}/x.js"></script>`)]),
    ).toHaveLength(1);
  });

  it("stays linear on hostile input (unclosed quotes, tags and comments by the thousand)", () => {
    const started = Date.now();
    for (const unit of [
      `<script data-x="`,
      `<script src='${HOST} `,
      `<!-- `,
      `<noscript `,
      `<script a=b c `,
    ]) {
      detect([file("layout/theme.liquid", `${unit.repeat(40_000)}\n${TAG}`)]);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("small precision gaps closed (round 5, independent review of 757b451)", () => {
  it.each([
    `https://evil.com#@${HOST}/x.js`,
    `https://evil.com?@${HOST}/x.js`,
    `https://evil.com\\@${HOST}/x.js`,
    `//evil.com#@${HOST}/x.js`,
  ])("a listed host after `@` is not the host when the authority already ended: %s", (url) => {
    expect(detect([file("layout/theme.liquid", `<script src="${url}"></script>`)])).toEqual([]);
    expect(detect([file("layout/theme.liquid", `{{ '${url}' | script_tag }}`)])).toEqual([]);
  });

  it("control: real userinfo before the listed host still matches", () => {
    expect(
      detect([file("layout/theme.liquid", `<script src="https://user:pw@${HOST}/x.js"></script>`)]),
    ).toHaveLength(1);
  });

  it("a src quote that never closes: nothing, and the rest of the file is not read", () => {
    expect(
      detect([
        file("layout/theme.liquid", `<script src="https://${HOST}/x.js></script>\n<p>hi</p>`),
      ]),
    ).toEqual([]);
    expect(
      detect([
        file(
          "layout/theme.liquid",
          `<script data-x="oops></script>\n<script src=https://${HOST}/x.js></script>`,
        ),
      ]),
    ).toEqual([]);
  });

  it.each([
    `{{ 'x' | append: 'https://${HOST}/x.js' | script_tag }}`,
    `{{ 'a' | replace: 'b', 'https://${HOST}/x.js' | script_tag }}`,
    `{{ 'a' | replace: 'b' ,\n  "https://${HOST}/x.js" | script_tag }}`,
  ])(
    "a URL that is an ARGUMENT of an earlier filter is not what script_tag prints: %s",
    (content) => {
      expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
    },
  );

  it.each([
    `{{ 'https://${HOST}/x.js' | script_tag }}`,
    `{{- "https://${HOST}/x.js" | script_tag -}}`,
    `{{'https://${HOST}/x.js'|script_tag}}`,
    `{% echo 'https://${HOST}/x.js' | script_tag %}`,
  ])("control: a URL that script_tag is applied to still fires: %s", (content) => {
    expect(detect([file("layout/theme.liquid", content)])).toHaveLength(1);
  });
});

// The limits the detector accepts. Each test PINS current behaviour so a
// change is deliberate; the runbook and the detector's doc comment list them.
describe("known limits (accepted, pinned)", () => {
  const fires = (content: string) => detect([file("layout/theme.liquid", content)]).length === 1;

  describe("false positives: reported, though the script does not load", () => {
    it("a script tag inside {% if false %}", () => {
      expect(fires(`{% if false %}${TAG}{% endif %}`)).toBe(true);
    });

    it("a script tag inside a {% capture %} that is never output", () => {
      expect(fires(`{% capture unused %}${TAG}{% endcapture %}`)).toBe(true);
    });

    it("a script tag written inside another tag's attribute value", () => {
      expect(fires(`<div data-html='<script src="https://${HOST}/x.js"></script>'></div>`)).toBe(
        true,
      );
    });

    it("a script tag in an outer <template> after a nested <template> closed", () => {
      expect(fires(`<template><template></template>${TAG}</template>`)).toBe(true);
    });

    it("a script tag written as text inside {% javascript %} or {% stylesheet %}", () => {
      expect(fires(`{% javascript %}\n// old: ${TAG}\n{% endjavascript %}`)).toBe(true);
      expect(fires(`{% stylesheet %}\n/* ${TAG} */\n{% endstylesheet %}`)).toBe(true);
    });

    it("a script tag inside a Liquid string that is never output", () => {
      expect(fires(`{% assign old = '${TAG}' %}`)).toBe(true);
    });

    it("a script tag with a type the browser does not run", () => {
      expect(fires(`<script type="text/template" src="https://${HOST}/x.js"></script>`)).toBe(true);
    });

    it("a script tag inside <svg> (an SVG script loads from href, not src)", () => {
      expect(fires(`<svg><script src="https://${HOST}/x.js"></script></svg>`)).toBe(true);
    });

    it("a JavaScript slash escape written literally in a src attribute", () => {
      expect(fires(`<script src="https:\\u002f\\u002f${HOST}/x.js"></script>`)).toBe(true);
    });
  });

  describe("false negatives: loads, but not reported", () => {
    it("a script tag printed from {% raw %}", () => {
      expect(fires(`{% raw %}${TAG}{% endraw %}`)).toBe(false);
    });

    it("a `>` inside Liquid within the tag, before src", () => {
      expect(
        fires(`<script {% if a > b %}defer{% endif %} src="https://${HOST}/x.js"></script>`),
      ).toBe(false);
    });

    it("a URL built with `append` before script_tag", () => {
      expect(fires(`{{ 'https://${HOST}/' | append: 'hulkcode.js' | script_tag }}`)).toBe(false);
    });

    it("a URL held in a variable, then script_tag", () => {
      expect(fires(`{% assign u = 'https://${HOST}/hulkcode.js' %}{{ u | script_tag }}`)).toBe(
        false,
      );
    });

    it("a script created by an inline script (createElement)", () => {
      expect(
        fires(
          `<script>var s=document.createElement("script");s.src="https://${HOST}/x.js";document.head.appendChild(s);</script>`,
        ),
      ).toBe(false);
    });

    it("a script written by an inline script (document.write)", () => {
      expect(
        fires(`<script>document.write('<script src="https://${HOST}/x.js"><\\/script>');</script>`),
      ).toBe(false);
    });

    it("anything after a `<!--` that sits in an attribute value and is never followed by -->", () => {
      expect(fires(`<div data-marker="<!--"></div>\n${TAG}`)).toBe(false);
    });

    it("a script tag after an empty comment written `<!-->` (read as open until the next -->)", () => {
      expect(fires(`<!-->\n${TAG}\n<!-- x -->`)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// In the whole scan
// ---------------------------------------------------------------------------

describe("scanThemeFiles with an advisory", () => {
  /** The scan at a pinned date on which the entry is active. */
  const scan = (files: Array<{ filename: string; content: string }>) =>
    scanThemeFiles(files, ACTIVE);
  const advisories = (files: Array<{ filename: string; content: string }>) =>
    scan(files).findings.filter((f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY);

  it("emits one advisory for a theme that loads the script from several files", () => {
    const found = advisories([
      file("layout/theme.liquid", `<html><head>${TAG}</head></html>`),
      file("sections/main-product.liquid", TAG),
      file("templates/product.json", `{"sections":{}}`),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      filename: "layout/theme.liquid",
      severity: Severity.HIGH,
      description: DESCRIPTION,
    });
    expect(found[0].appName).toBeUndefined();
  });

  it("passes its `now` to the detector: nothing after the review date", () => {
    const files = [file("layout/theme.liquid", TAG)];
    expect(
      scanThemeFiles(files, new Date("2027-01-09T00:00:00Z")).findings.some(
        (f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY,
      ),
    ).toBe(false);
  });

  it("still fires for a file over the per-file size cap (the differ treats it as cross-file)", () => {
    const padded = `${TAG}\n${"<p>x</p>\n".repeat(130_000)}`;
    expect(padded.length).toBeGreaterThan(1_000_000);
    const result = scan([file("layout/theme.liquid", padded)]);
    expect((result.skippedFiles ?? []).map((f) => f.filename)).toEqual(["layout/theme.liquid"]);
    expect(
      result.findings.filter((f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY),
    ).toHaveLength(1);
  });

  it("is never dropped by the active-app pass (an advisory is not a live app's own code)", () => {
    const settings = JSON.stringify({
      current: {
        blocks: {
          a: {
            type: "shopify://apps/klaviyo-email-marketing-sms/blocks/klaviyo-onsite-embed/1",
            disabled: false,
          },
        },
      },
    });
    const files = [file("config/settings_data.json", settings), file("layout/theme.liquid", TAG)];
    const [liveApp] = [...enabledAppEmbedApps(files)];
    // Non-vacuous: an app IS live in this theme, so the pass does run.
    expect(liveApp).toBeDefined();

    expect(advisories(files)).toHaveLength(1);

    const advisory = {
      filename: "layout/theme.liquid",
      lineNumber: 1,
      codeSnippet: TAG,
      findingType: FindingType.APP_INCIDENT_ADVISORY,
      severity: Severity.HIGH,
      appName: liveApp,
      description: DESCRIPTION,
    };
    const ghost = { ...advisory, findingType: FindingType.GHOST_SCRIPT };
    expect(dropActiveAppOwnFileFindings(files, [advisory, ghost])).toEqual([advisory]);
    expect(ACTIVE_APP_OWN_FILE_TYPES.has(FindingType.APP_INCIDENT_ADVISORY)).toBe(false);
  });

  it("can never corroborate a leftover app embed", () => {
    expect(ORPHAN_GRADE_CORROBORATION_TYPES.has(FindingType.APP_INCIDENT_ADVISORY)).toBe(false);
  });

  it("creates no GHOST_APP_EMBED and no other finding that names the advisory's app", () => {
    const { findings } = scan([file("layout/theme.liquid", `<html>${TAG}</html>`)]);
    expect(findings.some((f) => f.findingType === FindingType.GHOST_APP_EMBED)).toBe(false);
    expect(findings.some((f) => f.appName === HULK.appName)).toBe(false);
  });

  it("is not also reported as malicious code", () => {
    const { findings } = scan([file("layout/theme.liquid", TAG)]);
    expect(findings.some((f) => f.findingType === FindingType.MALICIOUS_SCRIPT)).toBe(false);
    expect(detectMaliciousScripts(file("layout/theme.liquid", TAG))).toEqual([]);
  });

  it("the engine never touches the unknown-script collectors for it: the host is collected whatever the flag", () => {
    const FLAG = "APP_INCIDENT_ADVISORY_LIVE_ENABLED";
    const files = [file("layout/theme.liquid", TAG)];
    try {
      for (const value of [undefined, "true"]) {
        if (value === undefined) delete process.env[FLAG];
        else process.env[FLAG] = value;
        const { unknownScripts, findings } = scan(files);
        expect(unknownScripts.map((s) => s.url)).toEqual([`https://${HOST}/hulkcode.js`]);
        expect(findings.some((f) => f.findingType === FindingType.GHOST_SCRIPT)).toBe(false);
      }
    } finally {
      delete process.env[FLAG];
    }
  });

  it("a theme without the script gets no advisory", () => {
    expect(
      advisories([
        file("layout/theme.liquid", `<script src="https://cdn.shopify.com/x.js"></script>`),
      ]),
    ).toEqual([]);
  });

  it("is a signature-grade detection: it fires only on a curated-list match", () => {
    expect(getFindingConfidence("APP_INCIDENT_ADVISORY")).toBe("signature");
  });

  // A11: with the check dark, the scan's WHOLE result is what it would be on
  // a build without the advisory, apart from the advisory rows themselves
  // (which the worker suppresses and counts). Nothing else may move.
  describe("whole-result equality on a rich theme", () => {
    const RICH = [
      file(
        "layout/theme.liquid",
        [
          "<html><head>",
          '<meta name="description" content="a"><meta name="description" content="b">',
          '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>',
          '<link rel="stylesheet" href="https://a.klaviyo.com/media/css/onsite/onsite.css">',
          '<link rel="preconnect" href="https://static.klaviyo.com">',
          '<script src="https://cdn.unknown-vendor.test/widget.js"></script>',
          '<script src="https://shopify.jsdeliver.cloud/config.js"></script>',
          '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage"}</script>',
          '<script type="application/ld+json">{ broken json </script>',
          '<meta name="robots" content="noindex">',
          "{% render 'klaviyo-form' %}",
          TAG,
          `<a href="https://${HOST}/">docs</a>`,
          "<script>fbq('init', '123');</script>",
          "</head><body>{{ content_for_layout }}</body></html>",
        ].join("\n"),
      ),
      file("layout/theme.pagefly.liquid", "<html>{{ content_for_layout }}</html>"),
      file("templates/index.json", '{"sections":{},"order":[]}'),
      file(
        "templates/product.json",
        `{"sections":{"x":{"settings":{"html":"https://${HOST}/x.js"}}}}`,
      ),
      file("snippets/klaviyo-form.liquid", "<div>form</div>"),
      file("snippets/judgeme_widgets.liquid", "<div class='jdgm-widget'></div>"),
      file("sections/main-product.liquid", `<div>{{ product.title }}</div>\n${TAG}`),
      file(
        "assets/theme.js",
        `fetch("https://${HOST}/api");\nvar u = "https://cb28utrk.com/scripts/shopify/click.js";`,
      ),
      file(
        "config/settings_data.json",
        '{"current":{"sections":{"gone":{"type":"missing-section"}}}}',
      ),
    ];
    const isAdvisory = (f: { findingType: string }) =>
      f.findingType === FindingType.APP_INCIDENT_ADVISORY;

    it("the fixture is rich: many finding types, an unknown script, and one advisory", () => {
      const result = scan(RICH);
      const types = new Set(result.findings.map((f) => f.findingType));
      expect(types.size).toBeGreaterThanOrEqual(6);
      expect(types.has(FindingType.MALICIOUS_SCRIPT)).toBe(true);
      expect(result.findings.filter(isAdvisory)).toHaveLength(1);
      expect(result.unknownScripts.length).toBeGreaterThanOrEqual(2);
    });

    it("with the advisory rows taken out, the result deep-equals a scan with no list entry to match", () => {
      const withAdvisory = scan(RICH);
      // "A build without the advisory": the same engine at a date when no
      // entry can fire, so the detector emits nothing.
      const without = scanThemeFiles(RICH, new Date("2030-01-01T00:00:00Z"));
      expect(without.findings.some(isAdvisory)).toBe(false);

      expect({
        ...withAdvisory,
        findings: withAdvisory.findings.filter((f) => !isAdvisory(f)),
      }).toEqual(without);
      // Order of every other finding is untouched too.
      expect(withAdvisory.findings.filter((f) => !isAdvisory(f))).toEqual(without.findings);
    });

    it("the flag itself changes nothing in the engine's output", () => {
      const FLAG = "APP_INCIDENT_ADVISORY_LIVE_ENABLED";
      try {
        delete process.env[FLAG];
        const off = scan(RICH);
        process.env[FLAG] = "true";
        const on = scan(RICH);
        expect(on).toEqual(off);
      } finally {
        delete process.env[FLAG];
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe("activeAdvisories", () => {
  it("is the entries that have not passed their review date, in list order", () => {
    expect(activeAdvisories(new Date("2026-10-20T00:00:00Z"), [HULK, OTHER])).toEqual([
      HULK,
      OTHER,
    ]);
    expect(activeAdvisories(new Date("2026-12-01T00:00:00Z"), [HULK, OTHER])).toEqual([HULK]);
    expect(activeAdvisories(new Date("2027-01-09T00:00:00Z"), [HULK, OTHER])).toEqual([]);
  });

  it("uses the real list by default and never mutates it", () => {
    expect(activeAdvisories(ACTIVE)).toEqual([...APP_INCIDENT_ADVISORIES]);
    expect(activeAdvisories(new Date("2030-01-01T00:00:00Z"))).toEqual([]);
    expect(APP_INCIDENT_ADVISORIES).toHaveLength(4);
  });
});

describe("the banner's report link for a stored advisory (buildSecurityRisks)", () => {
  const stored = { findingType: "APP_INCIDENT_ADVISORY", description: DESCRIPTION };

  it("resolves a stored finding to its entry's public report", () => {
    expect(bannerSourceUrl(stored, ACTIVE)).toBe(
      "https://romanzipp.com/blog/shopify-hit-with-phishing-attack",
    );
  });

  it("resolves the finding the detector actually emits (round trip)", () => {
    const [finding] = detect([file("layout/theme.liquid", TAG)]);
    expect(bannerSourceUrl(finding, ACTIVE)).toBe(HULK.sourceUrl);
  });

  it("picks the right entry among several, by any of its script hosts", () => {
    const [finding] = detect(
      [file("layout/theme.liquid", `<script src="https://legacy.example-reviews.test/w.js">`)],
      ACTIVE,
      [HULK, OTHER],
    );
    expect(bannerSourceUrl(finding, ACTIVE, [HULK, OTHER])).toBe(OTHER.sourceUrl);
    expect(bannerSourceUrl(stored, ACTIVE, [OTHER, HULK])).toBe(HULK.sourceUrl);
  });

  it("no link once the entry has passed its review date", () => {
    expect(bannerSourceUrl(stored, new Date("2027-01-08T23:59:59Z"))).toBe(HULK.sourceUrl);
    expect(bannerSourceUrl(stored, new Date("2027-01-09T00:00:00Z"))).toBeNull();
  });

  it("no link when the entry was removed from the list", () => {
    expect(bannerSourceUrl(stored, ACTIVE, [])).toBeNull();
    expect(bannerSourceUrl(stored, ACTIVE, [OTHER])).toBeNull();
  });

  it("no link when the entry was reworded since the scan (it can no longer be matched for certain)", () => {
    const reworded = { ...HULK, summary: "named in a different report" };
    expect(bannerSourceUrl(stored, ACTIVE, [reworded])).toBeNull();
  });

  it.each([
    [
      "another finding type with the same text",
      { findingType: "MALICIOUS_SCRIPT", description: DESCRIPTION },
    ],
    ["an empty description", { findingType: "APP_INCIDENT_ADVISORY", description: "" }],
    [
      "a near miss (trailing period)",
      { findingType: "APP_INCIDENT_ADVISORY", description: `${DESCRIPTION}.` },
    ],
    [
      "a different case",
      { findingType: "APP_INCIDENT_ADVISORY", description: DESCRIPTION.toLowerCase() },
    ],
  ])("no link for %s", (_label, finding) => {
    expect(bannerSourceUrl(finding, ACTIVE)).toBeNull();
  });

  it("uses the real list and the current date by default (clock pinned)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(ACTIVE);
      expect(bannerSourceUrl(stored)).toBe(HULK.sourceUrl);
      vi.setSystemTime(new Date("2027-01-09T00:00:00Z"));
      expect(bannerSourceUrl(stored)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("no double report: dropAdvisoryUnknownScripts", () => {
  const u = (url: string, resourceType = "script") => ({
    url,
    resourceType,
    filename: "layout/theme.liquid",
  });
  const SCRIPT = u(`https://${HOST}/hulkcode.js`);
  const STYLE = u(`https://${HOST}/hulk.css`, "stylesheet");
  const SUB = u(`https://cdn.${HOST}/x.js`);
  const UNKNOWN = u("https://cdn.unknown-vendor.test/a.js");
  const SIBLING = u("https://other-app.hulkapps.com/x.js");
  const ALL = [SCRIPT, UNKNOWN, STYLE, SUB, SIBLING];
  const PERSISTED = [{ findingType: "APP_INCIDENT_ADVISORY", description: DESCRIPTION }];

  it("an advisory for the entry is being stored: its host's rows are dropped, everything else stays in order", () => {
    expect(dropAdvisoryUnknownScripts(ALL, PERSISTED)).toEqual([UNKNOWN, SIBLING]);
  });

  it("no advisory stored (check dark, draft theme, expired, or the host is only mentioned): nothing is dropped", () => {
    expect(dropAdvisoryUnknownScripts(ALL, [])).toEqual(ALL);
    expect(
      dropAdvisoryUnknownScripts(ALL, [{ findingType: "GHOST_SCRIPT", description: DESCRIPTION }]),
    ).toEqual(ALL);
  });

  it("uses the SAME notion of matched as the detector: end to end on one theme", () => {
    // The host is only mentioned in ways that do not load it: no advisory, so
    // the (stylesheet) row the collector produced is NOT dropped.
    const mentionOnly = [
      file(
        "layout/theme.liquid",
        `<link rel="stylesheet" href="https://${HOST}/hulk.css">\n<a href="https://${HOST}/">x</a>`,
      ),
    ];
    const a = scanThemeFiles(mentionOnly, ACTIVE);
    expect(a.findings.some((f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY)).toBe(false);
    expect(dropAdvisoryUnknownScripts(a.unknownScripts, a.findings).map((s) => s.url)).toEqual([
      `https://${HOST}/hulk.css`,
    ]);

    // The script is loaded: the advisory exists, and every row on the host goes.
    const loaded = [
      file(
        "layout/theme.liquid",
        `${TAG}\n<link rel="stylesheet" href="https://${HOST}/hulk.css">\n<script src="https://cdn.unknown-vendor.test/a.js"></script>`,
      ),
    ];
    const b = scanThemeFiles(loaded, ACTIVE);
    expect(b.unknownScripts).toHaveLength(3);
    expect(dropAdvisoryUnknownScripts(b.unknownScripts, b.findings).map((s) => s.url)).toEqual([
      "https://cdn.unknown-vendor.test/a.js",
    ]);

    // After the review date the engine emits no advisory: nothing is dropped.
    const c = scanThemeFiles(loaded, new Date("2027-01-09T00:00:00Z"));
    expect(dropAdvisoryUnknownScripts(c.unknownScripts, c.findings)).toHaveLength(3);
  });

  it("only the entry that is reported is dropped", () => {
    const other = u("https://widgets.example-reviews.test/w.js");
    expect(dropAdvisoryUnknownScripts([SCRIPT, other], PERSISTED, [HULK, OTHER])).toEqual([other]);
  });

  it("a finding whose entry is no longer on the list drops nothing", () => {
    expect(dropAdvisoryUnknownScripts(ALL, PERSISTED, [])).toEqual(ALL);
    expect(dropAdvisoryUnknownScripts(ALL, PERSISTED, [OTHER])).toEqual(ALL);
  });

  it("keeps a row whose URL has no parseable host, and never mutates its input", () => {
    const odd = u("not a url");
    const input = [SCRIPT, odd];
    expect(dropAdvisoryUnknownScripts(input, PERSISTED)).toEqual([odd]);
    expect(input).toEqual([SCRIPT, odd]);
    expect(dropAdvisoryUnknownScripts([], PERSISTED)).toEqual([]);
  });
});
