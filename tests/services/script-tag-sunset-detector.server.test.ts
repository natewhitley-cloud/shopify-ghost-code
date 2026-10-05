import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  detectScriptTagSunset,
  SCRIPT_TAG_FINDING_FILENAME,
  SCRIPT_TAG_SUNSET_AT_MS,
  stripQueryAndFragment,
} from "../../app/services/script-tag-sunset-detector.server";

const SHOP = "paw-naturals-llc.myshopify.com";
const BEFORE = new Date("2026-10-05T12:00:00Z");
const AFTER = new Date("2027-06-01T00:00:00Z");
const NO_EMBEDS = new Set<string>();

// The real pawnaturals.com asyncLoad list (already JSON-unescaped).
const PAW_URLS = [
  `https://www.magisto.com/media/shopify/magisto.js?shop=${SHOP}`,
  `https://str.rise-ai.com/?shop=${SHOP}`,
  `https://d5zu2f4xvqanl.cloudfront.net/42/fe/loader_2.js?shop=${SHOP}`,
  `https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=MEqSVx&shop=${SHOP}`,
  `https://cdn.pushowl.com/latest/sdks/pushowl-shopify.js?subdomain=paw-naturals-llc&environment=production&guid=9ba1f5ec-5ec0-409b-b53c-d4820e1babb6&shop=${SHOP}`,
];

describe("stripQueryAndFragment", () => {
  it("drops the query string and fragment", () => {
    expect(stripQueryAndFragment("https://a.example.com/x.js?shop=s&token=t#frag")).toBe(
      "https://a.example.com/x.js",
    );
  });

  it("keeps the path, and the root path for a bare host", () => {
    expect(stripQueryAndFragment(`https://str.rise-ai.com/?shop=${SHOP}`)).toBe(
      "https://str.rise-ai.com/",
    );
    expect(stripQueryAndFragment("https://str.rise-ai.com")).toBe("https://str.rise-ai.com/");
  });

  it("reads protocol-relative URLs as https", () => {
    expect(stripQueryAndFragment("//cdn.example.com/a.js?x=1")).toBe(
      "https://cdn.example.com/a.js",
    );
  });

  it("keeps http as http", () => {
    expect(stripQueryAndFragment("http://cdn.example.com/a.js")).toBe(
      "http://cdn.example.com/a.js",
    );
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/javascript,alert(1)"],
    ["ftp://cdn.example.com/a.js"],
    ["not a url"],
    ["/relative/path.js"],
    [""],
    ["   "],
  ])("rejects %j", (raw) => {
    expect(stripQueryAndFragment(raw)).toBeNull();
  });
});

describe("detectScriptTagSunset", () => {
  it("returns no findings for no ScriptTags", () => {
    expect(detectScriptTagSunset([], NO_EMBEDS, BEFORE)).toEqual([]);
  });

  it("emits one finding per app or host on the real pawnaturals list", () => {
    const findings = detectScriptTagSunset(PAW_URLS, NO_EMBEDS, BEFORE);
    expect(findings).toHaveLength(5);
    for (const f of findings) {
      expect(f.findingType).toBe(FindingType.SCRIPT_TAG_SUNSET);
      expect(f.filename).toBe(SCRIPT_TAG_FINDING_FILENAME);
      expect(f.lineNumber).toBe(1);
    }
    expect(findings.map((f) => f.appName ?? null).sort()).toEqual([
      "Klaviyo",
      "PushOwl",
      null,
      null,
      null,
    ]);
  });

  it("never stores a query string, guid, or shop id", () => {
    const findings = detectScriptTagSunset(PAW_URLS, NO_EMBEDS, BEFORE);
    for (const f of findings) {
      expect(f.codeSnippet).not.toMatch(/[?#]/);
      expect(f.codeSnippet).not.toContain(SHOP);
      expect(f.codeSnippet).not.toContain("9ba1f5ec");
      expect(f.codeSnippet).not.toContain("MEqSVx");
      expect(f.description).not.toContain(SHOP);
    }
  });

  it("groups several URLs of the same signature app into one finding, sorted and deduped", () => {
    const findings = detectScriptTagSunset(
      [
        "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=A",
        "https://a.klaviyo.com/media/js/onsite.js",
        "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=B",
      ],
      NO_EMBEDS,
      BEFORE,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("Klaviyo");
    expect(findings[0].codeSnippet).toBe(
      "https://a.klaviyo.com/media/js/onsite.js\nhttps://static.klaviyo.com/onsite/js/klaviyo.js",
    );
  });

  it("groups unmatched URLs by hostname and names the host, not an app", () => {
    const findings = detectScriptTagSunset(
      [
        "https://d5zu2f4xvqanl.cloudfront.net/42/fe/loader_2.js",
        "https://d5zu2f4xvqanl.cloudfront.net/42/fe/other.js",
        "https://widgets.unknown-vendor.io/w.js",
      ],
      NO_EMBEDS,
      BEFORE,
    );
    expect(findings).toHaveLength(2);
    const cloudfront = findings.find((f) => f.codeSnippet.includes("cloudfront"));
    expect(cloudfront?.appName).toBeUndefined();
    expect(cloudfront?.codeSnippet.split("\n")).toHaveLength(2);
    expect(cloudfront?.description).toMatch(
      /^An app loading from d5zu2f4xvqanl\.cloudfront\.net loads on your storefront through a script tag\./,
    );
    expect(cloudfront?.description).toContain("Ask that app's support");
  });

  it("produces the same snippets in the same order whatever the input order", () => {
    const a = detectScriptTagSunset(PAW_URLS, NO_EMBEDS, BEFORE);
    const b = detectScriptTagSunset([...PAW_URLS].reverse(), NO_EMBEDS, BEFORE);
    expect(b).toEqual(a);
  });

  it("names a cdn.shopify.com ScriptTag as an app script hosted on Shopify's CDN", () => {
    const [f] = detectScriptTagSunset(
      ["https://cdn.shopify.com/s/files/1/0001/t/1/assets/app.js?v=123"],
      NO_EMBEDS,
      BEFORE,
    );
    expect(f.appName).toBeUndefined();
    expect(f.severity).toBe(Severity.HIGH);
    expect(f.codeSnippet).toBe("https://cdn.shopify.com/s/files/1/0001/t/1/assets/app.js");
    expect(f.description).toMatch(
      /^An app script hosted on Shopify's CDN loads on your storefront/,
    );
  });

  it("drops non-http(s), unparseable, and non-string entries", () => {
    const findings = detectScriptTagSunset(
      [
        "javascript:void(0)",
        "not a url",
        "",
        42 as unknown as string,
        null as unknown as string,
        "https://cdn.pushowl.com/a.js",
      ],
      NO_EMBEDS,
      BEFORE,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe("PushOwl");
  });

  describe("severity vs app embeds", () => {
    const KLAVIYO = ["https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"];

    it("is HIGH when the app has no enabled embed", () => {
      expect(detectScriptTagSunset(KLAVIYO, NO_EMBEDS, BEFORE)[0].severity).toBe(Severity.HIGH);
    });

    it("is LOW when the app has an enabled embed (probably already moved)", () => {
      const [f] = detectScriptTagSunset(KLAVIYO, new Set(["Klaviyo"]), BEFORE);
      expect(f.severity).toBe(Severity.LOW);
      expect(f.description).toContain("Klaviyo also has an app embed turned on in your theme");
      expect(f.description).toContain("Worth confirming with Klaviyo's support.");
    });

    it("is HIGH when only a DIFFERENT app's embed is enabled (a disabled embed is never in the set)", () => {
      expect(detectScriptTagSunset(KLAVIYO, new Set(["PushOwl"]), BEFORE)[0].severity).toBe(
        Severity.HIGH,
      );
    });

    it("never lowers an unmatched host, whatever embeds are enabled", () => {
      const [f] = detectScriptTagSunset(
        ["https://widgets.unknown-vendor.io/w.js"],
        new Set(["widgets.unknown-vendor.io", "Klaviyo"]),
        BEFORE,
      );
      expect(f.severity).toBe(Severity.HIGH);
    });
  });

  describe("date-aware copy", () => {
    const KLAVIYO = ["https://static.klaviyo.com/onsite/js/klaviyo.js"];
    const justBefore = new Date(SCRIPT_TAG_SUNSET_AT_MS - 1);
    const exactly = new Date("2027-03-01T00:00:00Z");

    it("the boundary is 2027-03-01T00:00:00Z", () => {
      expect(exactly.getTime()).toBe(SCRIPT_TAG_SUNSET_AT_MS);
    });

    it("uses future tense one millisecond before the cutoff", () => {
      const [f] = detectScriptTagSunset(KLAVIYO, NO_EMBEDS, justBefore);
      expect(f.description).toBe(
        "Klaviyo loads on your storefront through a script tag. Shopify will stop running script tags on March 1, 2027, so the parts of Klaviyo that rely on it will stop working on your store unless Klaviyo moves to an app embed before then. Ask Klaviyo's support whether they have migrated.",
      );
    });

    it("uses past tense exactly at the cutoff", () => {
      const [f] = detectScriptTagSunset(KLAVIYO, NO_EMBEDS, exactly);
      expect(f.description).toBe(
        "Klaviyo loads on your storefront through a script tag. Shopify stopped running script tags on March 1, 2027, so the parts of Klaviyo that rely on it have stopped working on your store unless Klaviyo has moved to an app embed. Ask Klaviyo's support whether they have migrated.",
      );
      expect(f.severity).toBe(Severity.HIGH);
    });

    it("LOW copy: future before, past at the cutoff", () => {
      const embeds = new Set(["Klaviyo"]);
      expect(detectScriptTagSunset(KLAVIYO, embeds, justBefore)[0].description).toBe(
        "Klaviyo loads on your storefront through a script tag, which Shopify will stop running on March 1, 2027. Klaviyo also has an app embed turned on in your theme, so it has probably moved already. Worth confirming with Klaviyo's support.",
      );
      expect(detectScriptTagSunset(KLAVIYO, embeds, exactly)[0].description).toBe(
        "Klaviyo loads on your storefront through a script tag, which Shopify stopped running on March 1, 2027. Klaviyo also has an app embed turned on in your theme, so it has probably moved already. Worth confirming with Klaviyo's support.",
      );
    });

    it("an unmatched host reads 'that app' in past tense too", () => {
      const [f] = detectScriptTagSunset(["https://x.vendor.io/a.js"], NO_EMBEDS, AFTER);
      expect(f.description).toContain("so the parts of that app that rely on it have stopped");
      expect(f.description).toContain("unless that app has moved to an app embed");
    });
  });

  it("never emits an em dash (or en dash) in any generated copy", () => {
    const inputs = [
      ...PAW_URLS,
      "https://cdn.shopify.com/s/files/1/app.js",
      "https://x.vendor.io/a.js",
    ];
    for (const now of [BEFORE, AFTER]) {
      for (const embeds of [NO_EMBEDS, new Set(["Klaviyo", "PushOwl"])]) {
        for (const f of detectScriptTagSunset(inputs, embeds, now)) {
          expect(f.description).not.toMatch(/[—–]/);
        }
      }
    }
  });
});
