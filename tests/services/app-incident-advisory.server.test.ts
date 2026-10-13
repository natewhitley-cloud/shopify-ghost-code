/**
 * Affected-app advisory (gc-14x5): the curated list
 * (app/data/app-incident-advisories.server.ts), its host matcher and review
 * dates, and the detector (detectAppIncidentAdvisories in the scan engine).
 *
 * The finding states two facts only: this app's code is in the theme, and a
 * public report names the app. Nothing here may ever claim the store was hit.
 */
import { FindingType, Severity } from "@prisma/client";
import { afterEach, describe, it, expect } from "vitest";

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
import { advisoryReportUrlForFinding } from "../../app/services/app-incident-advisory.server";
import {
  ACTIVE_APP_OWN_FILE_TYPES,
  collectUnknownScripts,
  collectUnknownStylesheets,
  detectAppIncidentAdvisories,
  detectMaliciousScripts,
  dropActiveAppOwnFileFindings,
  enabledAppEmbedApps,
  isShopifyDomain,
  ORPHAN_GRADE_CORROBORATION_TYPES,
  scanThemeFiles,
} from "../../app/services/scan-engine.server";

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
  incidentDate: "2026-09-01",
  sourceUrl: "https://example.test/report",
  summary: "named in a public report of a redirect on product pages",
  reviewBy: "2026-11-30",
};

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("APP_INCIDENT_ADVISORIES (list-level pins)", () => {
  it("holds exactly the one verified entry, with the owner's fields", () => {
    expect(APP_INCIDENT_ADVISORIES).toEqual([
      {
        appName: "Hulk Product Options",
        scriptHosts: ["productoption.hulkapps.com"],
        incidentDate: "2026-10-10",
        sourceUrl: "https://romanzipp.com/blog/shopify-hit-with-phishing-attack",
        summary: "named in a public report of shoppers being sent to a fake checkout page",
        reviewBy: "2027-01-08",
      },
    ]);
  });

  it("the Hulk review date is 90 days after the incident", () => {
    const days =
      (Date.parse(`${HULK.reviewBy}T00:00:00Z`) - Date.parse(`${HULK.incidentDate}T00:00:00Z`)) /
      86_400_000;
    expect(days).toBe(90);
  });

  it.each(APP_INCIDENT_ADVISORIES)("$appName: every field is well formed", (entry) => {
    expect(entry.appName.trim()).toBe(entry.appName);
    expect(entry.appName.length).toBeGreaterThan(0);
    expect(entry.scriptHosts.length).toBeGreaterThan(0);
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

  it("no advisory app name is also an app signature name (an advisory is not leftover code)", () => {
    // app-removal detection and the active-app pass key on signature app names.
    // The advisory finding carries no appName, and this keeps the two lists
    // from ever being confused for one another.
    const signatureNames = new Set(APP_SIGNATURES.map((s) => s.appName));
    for (const entry of APP_INCIDENT_ADVISORIES) {
      expect(signatureNames.has(entry.appName), entry.appName).toBe(false);
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

  it("uses the real list and the real clock by default", () => {
    // Guarded by the review-date test above: the entry is active today.
    expect(detectAppIncidentAdvisories([file("layout/theme.liquid", TAG)])).toHaveLength(1);
  });

  it.each([
    ["protocol-relative URL", `<script src="//${HOST}/hulkcode.js"></script>`],
    ["http URL", `<script src="http://${HOST}/hulkcode.js"></script>`],
    ["upper-case host", `<script src="https://PRODUCTOPTION.HULKAPPS.COM/hulkcode.js"></script>`],
    ["subdomain", `<script src="https://cdn.${HOST}/hulkcode.js"></script>`],
    ["single quotes", `<script src='https://${HOST}/hulkcode.js'></script>`],
    ["Liquid filter", `{{ '//${HOST}/hulkcode.js' | script_tag }}`],
    [
      "inline loader",
      `<script>var s=document.createElement("script");s.src="https://${HOST}/hulkcode.js";</script>`,
    ],
    ["trailing FQDN dot", `<script src="https://${HOST}./hulkcode.js"></script>`],
    ["port", `<script src="https://${HOST}:443/hulkcode.js"></script>`],
    ["query string", `<script src="https://${HOST}/hulkcode.js?shop=x.myshopify.com"></script>`],
  ])("flags a %s", (_label, line) => {
    const found = detect([file("layout/theme.liquid", line)]);
    expect(found).toHaveLength(1);
    expect(found[0].lineNumber).toBe(1);
    // The snippet is a window of that line that shows the host (the whole line
    // when the host starts within its first 40 characters).
    expect(line).toContain(found[0].codeSnippet);
    expect(found[0].codeSnippet.toLowerCase()).toContain(HOST);
  });

  it.each([
    [
      "JSON-escaped slashes",
      `{"html":"<script src=\\"https:\\/\\/${HOST}\\/hulkcode.js\\"><\\/script>"}`,
    ],
    ["double-escaped slashes", `{"html":"https:\\\\/\\\\/${HOST}\\\\/hulkcode.js"}`],
    ["decimal entity", `{"html":"https:&#47;&#47;${HOST}&#47;hulkcode.js"}`],
    ["hex entity", `{"html":"https:&#x2F;&#x2F;${HOST}&#x2F;hulkcode.js"}`],
    ["named entity", `{"html":"https:&sol;&sol;${HOST}&sol;hulkcode.js"}`],
  ])("flags encoded slashes in a JSON template (%s)", (_label, content) => {
    const found = detect([file("templates/product.json", content)]);
    expect(found).toHaveLength(1);
    expect(found[0].filename).toBe("templates/product.json");
    expect(found[0].codeSnippet).toBe(content);
  });

  it.each([
    ["templates/product.json", `{"custom_liquid":"<script src='https://${HOST}/x.js'></script>"}`],
    ["sections/header-group.json", `{"html":"https://${HOST}/x.js"}`],
    ["config/settings_data.json", `{"current":{"custom_html":"https://${HOST}/x.js"}}`],
    ["assets/theme.js", `fetch("https://${HOST}/api/options");`],
    ["assets/custom.mjs", `import("https://${HOST}/hulkcode.js");`],
    ["assets/theme.js.liquid", `var u = "https://${HOST}/hulkcode.js";`],
    ["locales/en.default.json", `{"x_html":"<script src='https://${HOST}/x.js'></script>"}`],
    ["snippets/hulk.liquid", TAG],
    ["sections/main-product.liquid", TAG],
    ["templates/product.liquid", TAG],
    ["blocks/options.liquid", TAG],
  ])("reads %s (the files the malicious pass reads)", (filename, content) => {
    const found = detect([file(filename, content)]);
    expect(found).toHaveLength(1);
    expect(found[0].filename).toBe(filename);
  });

  it.each([
    ["assets/theme.css", `.x{background:url(https://${HOST}/a.png)}`],
    ["assets/base.scss.liquid.txt", `https://${HOST}/hulkcode.js`],
    ["config/settings_schema.json", `[{"name":"https://${HOST}/hulkcode.js"}]`],
    ["README.md", `https://${HOST}/hulkcode.js`],
  ])("does not read %s", (filename, content) => {
    expect(detect([file(filename, content)])).toEqual([]);
  });

  describe("comments do not count", () => {
    it.each([
      ["{% comment %} block", `{% comment %}${TAG}{% endcomment %}`],
      ["{%- comment -%} block", `{%- comment -%}\n${TAG}\n{%- endcomment -%}`],
      ["{% doc %} block", `{% doc %}\n  Loads https://${HOST}/hulkcode.js\n{% enddoc %}`],
    ])("a Liquid comment in a .liquid file is ignored (%s)", (_label, content) => {
      expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
    });

    it("KNOWN LIMIT (shared with the malicious detector): an inline {% # %} comment is not blanked, so it counts", () => {
      // blankLiquidComments blanks comment and doc BLOCKS only. Pinned so a
      // change to that shared helper is a deliberate one for both detectors.
      expect(detect([file("layout/theme.liquid", `{% # ${TAG} %}`)])).toHaveLength(1);
      expect(
        detectMaliciousScripts(file("layout/theme.liquid", "{% # https://jsdeliver.cloud/x.js %}")),
      ).toHaveLength(1);
    });

    it.each([
      ["one line", `<!-- ${TAG} -->`],
      ["several lines", `<!--\n  removed 2026-10-11\n  ${TAG}\n-->`],
    ])("an HTML comment is ignored (%s)", (_label, content) => {
      expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
    });

    it.each([
      [
        "line comment in a <script> block",
        "layout/theme.liquid",
        `<script>\n  // s.src = "https://${HOST}/hulkcode.js";\n</script>`,
      ],
      [
        "block comment in a <script> block",
        "layout/theme.liquid",
        `<script>\n  /* s.src = "https://${HOST}/hulkcode.js"; */\n</script>`,
      ],
      [
        "line comment in an asset JS file",
        "assets/theme.js",
        `// old loader: https://${HOST}/hulkcode.js\nvar a = 1;`,
      ],
      [
        "block comment in an asset JS file",
        "assets/theme.js",
        `/*\n * fetch("https://${HOST}/api");\n */\nvar a = 1;`,
      ],
      [
        "block comment in a .js.liquid asset",
        "assets/theme.js.liquid",
        `/* https://${HOST}/hulkcode.js */`,
      ],
    ])("a JS comment is ignored (%s)", (_label, filename, content) => {
      expect(detect([file(filename, content)])).toEqual([]);
    });

    it("the same references ARE reported by the malicious detector's default path, so this is the comment rule and not a miss", () => {
      // Control: uncommented, each of the files above fires.
      expect(detect([file("layout/theme.liquid", TAG)])).toHaveLength(1);
      expect(
        detect([file("assets/theme.js", `var u = "https://${HOST}/hulkcode.js";`)]),
      ).toHaveLength(1);
    });

    it("live code beside a comment on the same line still counts", () => {
      const line = `<!-- old --> ${TAG}`;
      const found = detect([file("layout/theme.liquid", line)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(1);
    });

    it("skips a commented-out copy and anchors to the live one further down", () => {
      const content = [
        `<!-- ${TAG} -->`,
        `{% comment %}${TAG}{% endcomment %}`,
        "<p>x</p>",
        TAG,
      ].join("\n");
      const found = detect([file("layout/theme.liquid", content)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(4);
      expect(found[0].codeSnippet).toBe(TAG);
    });

    it("the snippet centres on the LIVE reference when a comment on the same line holds another", () => {
      const filler = "x".repeat(400);
      const line = `<!-- https://${HOST}/old.js -->${filler}<script src="https://${HOST}/hulkcode.js"></script>`;
      const [finding] = detect([file("layout/theme.liquid", line)]);
      expect(finding.codeSnippet).toContain("hulkcode.js");
      expect(finding.codeSnippet).not.toContain("old.js");
    });

    it("{% comment %} is literal text outside .liquid files, so a JSON reference inside one counts", () => {
      const content = `{"custom_liquid":"{% comment %}https://${HOST}/x.js{% endcomment %}"}`;
      expect(detect([file("templates/index.json", content)])).toHaveLength(1);
    });

    it("an unterminated HTML comment hides nothing (doubt resolves toward reporting)", () => {
      expect(detect([file("layout/theme.liquid", `<!-- oops\n${TAG}`)])).toHaveLength(1);
    });
  });

  describe("one finding per list entry per scan", () => {
    it("many references in one file give ONE finding, on the first line", () => {
      const content = [
        "<head>",
        TAG,
        TAG,
        `<link rel="preconnect" href="https://${HOST}">`,
        TAG,
      ].join("\n");
      const found = detect([file("layout/theme.liquid", content)]);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(2);
    });

    it("two references on one line give ONE finding", () => {
      expect(detect([file("layout/theme.liquid", `${TAG}${TAG}`)])).toHaveLength(1);
    });

    it("two files give ONE finding, anchored to the first file in scan order", () => {
      const files = [
        file("layout/theme.liquid", `<p>nothing</p>\n${TAG}`),
        file("sections/main-product.liquid", TAG),
        file("assets/theme.js", `var u = "https://${HOST}/hulkcode.js";`),
      ];
      const found = detect(files);
      expect(found).toHaveLength(1);
      expect(found[0].filename).toBe("layout/theme.liquid");
      expect(found[0].lineNumber).toBe(2);

      const reversed = detect([...files].reverse());
      expect(reversed).toHaveLength(1);
      expect(reversed[0].filename).toBe("assets/theme.js");
      expect(reversed[0].lineNumber).toBe(1);
    });

    it("a file whose only reference is commented out is passed over for the next file", () => {
      const found = detect([
        file("layout/theme.liquid", `<!-- ${TAG} -->`),
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

    it.each([
      [
        "sibling HulkApps app",
        `<script src="https://master-motivator.hulkapps.com/a.js"></script>`,
      ],
      ["vendor base domain", `<a href="https://hulkapps.com/">HulkApps</a>`],
      ["www of the base domain", `<a href="https://www.hulkapps.com/">HulkApps</a>`],
      ["lookalike prefix", `<script src="https://notproductoption.hulkapps.com/a.js"></script>`],
      [
        "host used as a prefix of another domain",
        `<script src="https://productoption.hulkapps.com.example.com/a.js"></script>`,
      ],
      [
        "the host as a path segment of another URL",
        `<script src="https://cdn.example.com//${HOST}/a.js"></script>`,
      ],
      ["the host named in prose, not a URL", `<p>We use ${HOST} for options</p>`],
      ["the host as a query value, not a URL", `<a href="/pages/x?host=${HOST}">x</a>`],
      [
        "the app's name without its host",
        `<!-- hulk product options -->\n<div class="hulkapps_product_options"></div>`,
      ],
    ])("%s: nothing", (_label, content) => {
      expect(detect([file("layout/theme.liquid", content)])).toEqual([]);
    });
  });

  describe("snippet", () => {
    it("starts 40 characters before the host on a line with a long lead, so the card preview shows the host", () => {
      const line = `<script>var s=document.createElement("script");s.src="https://${HOST}/hulkcode.js";</script>`;
      const [finding] = detect([file("layout/theme.liquid", line)]);
      expect(finding.codeSnippet).toBe(line.slice(line.indexOf(HOST) - 40));
      // The card previews the first 80 characters of the snippet.
      expect(finding.codeSnippet.slice(0, 80)).toContain(HOST);
    });

    it("is the same window the malicious detector would store for that line", () => {
      const lead = "x".repeat(120);
      const advisory = detect([file("layout/theme.liquid", `${lead}https://${HOST}/a.js`)])[0];
      const malicious = detectMaliciousScripts(
        file("layout/theme.liquid", `${lead}https://jsdeliver.cloud/a.js`),
      )[0];
      const window = `${"x".repeat(32)}https://`;
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
      const line = `${"a".repeat(5000)}fetch("https://${HOST}/api");${"b".repeat(5000)}`;
      const [finding] = detect([file("assets/theme.js", line)]);
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

  it("stays linear on a 1 MB single-line file", () => {
    const big = `${"x".repeat(1_000_000)} https://${HOST}/hulkcode.js`;
    const started = Date.now();
    const found = detect([file("assets/theme.js", big)]);
    expect(found).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
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
// In the whole scan
// ---------------------------------------------------------------------------

describe("scanThemeFiles with an advisory", () => {
  const advisories = (files: Array<{ filename: string; content: string }>) =>
    scanThemeFiles(files).findings.filter(
      (f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY,
    );

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

  it("still fires for a file over the per-file size cap (the differ treats it as cross-file)", () => {
    const padded = `${TAG}\n${"<p>x</p>\n".repeat(130_000)}`;
    expect(padded.length).toBeGreaterThan(1_000_000);
    const result = scanThemeFiles([file("layout/theme.liquid", padded)]);
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

    // Even an advisory that (wrongly) carried the live app's name would stay:
    // the pass only drops ACTIVE_APP_OWN_FILE_TYPES, and a ghost script with
    // that name (the control) IS dropped.
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
    const { findings } = scanThemeFiles([file("layout/theme.liquid", `<html>${TAG}</html>`)]);
    expect(findings.some((f) => f.findingType === FindingType.GHOST_APP_EMBED)).toBe(false);
    expect(findings.some((f) => f.appName === HULK.appName)).toBe(false);
  });

  it("is not also reported as malicious code", () => {
    const { findings } = scanThemeFiles([file("layout/theme.liquid", TAG)]);
    expect(findings.some((f) => f.findingType === FindingType.MALICIOUS_SCRIPT)).toBe(false);
    expect(detectMaliciousScripts(file("layout/theme.liquid", TAG))).toEqual([]);
  });

  it("with the check dark (flag off) the host is still an unknown script, as before the feature", () => {
    const { unknownScripts, findings } = scanThemeFiles([file("layout/theme.liquid", TAG)]);
    expect(unknownScripts.map((s) => s.url)).toEqual([`https://${HOST}/hulkcode.js`]);
    expect(findings.some((f) => f.findingType === FindingType.GHOST_SCRIPT)).toBe(false);
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
});

// ---------------------------------------------------------------------------
// Round 2: active entries, the report link, and no double report
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
    expect(APP_INCIDENT_ADVISORIES).toHaveLength(1);
  });
});

describe("advisoryReportUrlForFinding (the card's 'Read the report' link)", () => {
  const stored = { findingType: "APP_INCIDENT_ADVISORY", description: DESCRIPTION };

  it("resolves a stored finding to its entry's public report", () => {
    expect(advisoryReportUrlForFinding(stored, ACTIVE)).toBe(
      "https://romanzipp.com/blog/shopify-hit-with-phishing-attack",
    );
  });

  it("resolves the finding the detector actually emits (round trip)", () => {
    const [finding] = detect([file("layout/theme.liquid", TAG)]);
    expect(advisoryReportUrlForFinding(finding, ACTIVE)).toBe(HULK.sourceUrl);
  });

  it("picks the right entry among several, by any of its script hosts", () => {
    const [finding] = detect(
      [file("layout/theme.liquid", `<script src="https://legacy.example-reviews.test/w.js">`)],
      ACTIVE,
      [HULK, OTHER],
    );
    expect(advisoryReportUrlForFinding(finding, ACTIVE, [HULK, OTHER])).toBe(OTHER.sourceUrl);
    expect(advisoryReportUrlForFinding(stored, ACTIVE, [OTHER, HULK])).toBe(HULK.sourceUrl);
  });

  it("no link once the entry has passed its review date", () => {
    expect(advisoryReportUrlForFinding(stored, new Date("2027-01-08T23:59:59Z"))).toBe(
      HULK.sourceUrl,
    );
    expect(advisoryReportUrlForFinding(stored, new Date("2027-01-09T00:00:00Z"))).toBeNull();
  });

  it("no link when the entry was removed from the list", () => {
    expect(advisoryReportUrlForFinding(stored, ACTIVE, [])).toBeNull();
    expect(advisoryReportUrlForFinding(stored, ACTIVE, [OTHER])).toBeNull();
  });

  it("no link when the entry was reworded since the scan (it can no longer be matched for certain)", () => {
    const reworded = { ...HULK, summary: "named in a different report" };
    expect(advisoryReportUrlForFinding(stored, ACTIVE, [reworded])).toBeNull();
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
    expect(advisoryReportUrlForFinding(finding, ACTIVE)).toBeNull();
  });

  it("uses the real clock and list by default", () => {
    // Guarded by the review-date test: the entry is active today.
    expect(advisoryReportUrlForFinding(stored)).toBe(HULK.sourceUrl);
  });
});

describe("no double report: an advisory host is not also an 'unrecognized script'", () => {
  const FLAG = "APP_INCIDENT_ADVISORY_LIVE_ENABLED";
  const LINK = `<link rel="stylesheet" href="https://${HOST}/hulk.css">`;
  const theme = [
    file(
      "layout/theme.liquid",
      `${TAG}\n${LINK}\n<script src="https://cdn.unknown-vendor.test/a.js"></script>`,
    ),
  ];
  const unknownUrls = (now: Date) => scanThemeFiles(theme, now).unknownScripts.map((s) => s.url);

  afterEach(() => {
    delete process.env[FLAG];
  });

  it("flag ON and entry unexpired: the host is left out (script and stylesheet), other unknowns stay", () => {
    process.env[FLAG] = "true";
    expect(unknownUrls(ACTIVE)).toEqual(["https://cdn.unknown-vendor.test/a.js"]);
    // The advisory itself is still emitted.
    expect(
      scanThemeFiles(theme, ACTIVE).findings.filter(
        (f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY,
      ),
    ).toHaveLength(1);
  });

  it("flag OFF (the production default): the host is listed exactly as before", () => {
    expect(unknownUrls(ACTIVE)).toEqual([
      `https://${HOST}/hulkcode.js`,
      "https://cdn.unknown-vendor.test/a.js",
      `https://${HOST}/hulk.css`,
    ]);
  });

  it.each(["1", "TRUE", "false", ""])("flag %j is not on: listed as before", (value) => {
    process.env[FLAG] = value;
    expect(unknownUrls(ACTIVE)).toContain(`https://${HOST}/hulkcode.js`);
  });

  it("flag ON but the entry has EXPIRED: the host is listed again, and no advisory is emitted", () => {
    process.env[FLAG] = "true";
    const expired = new Date("2027-01-09T00:00:00Z");
    expect(unknownUrls(expired)).toEqual([
      `https://${HOST}/hulkcode.js`,
      "https://cdn.unknown-vendor.test/a.js",
      `https://${HOST}/hulk.css`,
    ]);
    expect(
      scanThemeFiles(theme, expired).findings.some(
        (f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY,
      ),
    ).toBe(false);
  });

  it("the boundary: left out on the review date, listed the day after", () => {
    process.env[FLAG] = "true";
    expect(unknownUrls(new Date("2027-01-08T12:00:00Z"))).not.toContain(
      `https://${HOST}/hulkcode.js`,
    );
    expect(unknownUrls(new Date("2027-01-09T12:00:00Z"))).toContain(`https://${HOST}/hulkcode.js`);
  });

  it("only the listed host is left out: a sibling HulkApps host unknown to GhostCode stays", () => {
    process.env[FLAG] = "true";
    const sibling = [
      file(
        "layout/theme.liquid",
        `${TAG}\n<script src="https://other-app.hulkapps.com/x.js"></script>`,
      ),
    ];
    expect(scanThemeFiles(sibling, ACTIVE).unknownScripts.map((s) => s.url)).toEqual([
      "https://other-app.hulkapps.com/x.js",
    ]);
  });

  it("the collectors themselves skip nothing unless told which entries are live", () => {
    const f = file("layout/theme.liquid", `${TAG}\n${LINK}`);
    expect(collectUnknownScripts(f)).toHaveLength(1);
    expect(collectUnknownStylesheets(f)).toHaveLength(1);
    expect(collectUnknownScripts(f, undefined, [HULK])).toEqual([]);
    expect(collectUnknownStylesheets(f, undefined, [HULK])).toEqual([]);
    expect(collectUnknownScripts(f, undefined, [OTHER])).toHaveLength(1);
  });
});
