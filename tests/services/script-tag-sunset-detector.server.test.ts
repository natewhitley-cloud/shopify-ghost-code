import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { fingerprintFinding } from "../../app/services/scan-differ.server";
import {
  detectScriptTagSunset,
  MAX_SCRIPT_TAG_GROUPS,
  MAX_SCRIPT_TAG_URL_LENGTH,
  MAX_SCRIPT_TAG_URLS,
  SCRIPT_TAG_FINDING_FILENAME,
  SCRIPT_TAG_SUNSET_AT_MS,
  normalizeScriptTagUrl,
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

describe("normalizeScriptTagUrl", () => {
  it.each([
    [
      "https://cdn.shopify.com/s/files/1/0013/1642/1703/t/1/assets/x.js?v=1#h",
      "https://cdn.shopify.com/s/files/<shop>/t/1/assets/x.js",
    ],
    [
      "https://cdn.shopify.com/s/files/1/0001/t/1/assets/app.js",
      "https://cdn.shopify.com/s/files/<shop>/t/1/assets/app.js",
    ],
    [
      "//cdn.shopify.com/s/files/1/0262/3367/6858/files/widget.js",
      "https://cdn.shopify.com/s/files/<shop>/files/widget.js",
    ],
    ["https://CDN.Shopify.com/s/files/1/0001/x.js", "https://cdn.shopify.com/s/files/<shop>/x.js"],
  ])("redacts the shop bucket in %s", (raw, expected) => {
    expect(normalizeScriptTagUrl(raw)).toBe(expected);
  });

  it.each([
    // Same path on another host: not Shopify's file bucket, left alone.
    ["https://cdn.vendor.io/s/files/1/0013/1642/1703/t/1/assets/x.js"],
    // No bucket id after the version segment.
    ["https://cdn.shopify.com/s/files/1/app.js"],
    // Not 4-digit chunks: not the bucket format.
    ["https://cdn.shopify.com/s/files/1/13/x.js"],
    // Theme app extension assets carry no shop id.
    ["https://cdn.shopify.com/extensions/0199c2a1-aaaa/app-1/assets/app.js"],
    // A lookalike segment later in the path.
    ["https://cdn.shopify.com/a/s/files/1/0013/x.js"],
  ])("leaves %s unchanged apart from the query", (raw) => {
    expect(normalizeScriptTagUrl(raw)).toBe(stripQueryAndFragment(raw));
  });

  it("returns null for anything stripQueryAndFragment rejects", () => {
    expect(normalizeScriptTagUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeScriptTagUrl("")).toBeNull();
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
      "Rise.ai",
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
      "script-tags: Klaviyo\nhttps://a.klaviyo.com/media/js/onsite.js\nhttps://static.klaviyo.com/onsite/js/klaviyo.js",
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
    expect(cloudfront?.codeSnippet.split("\n")).toEqual([
      "script-tags: host d5zu2f4xvqanl.cloudfront.net",
      "https://d5zu2f4xvqanl.cloudfront.net/42/fe/loader_2.js",
      "https://d5zu2f4xvqanl.cloudfront.net/42/fe/other.js",
    ]);
    expect(cloudfront?.description).toMatch(
      /^A script from d5zu2f4xvqanl\.cloudfront\.net, added by one of your apps, is loaded through a script tag\./,
    );
    expect(cloudfront?.description).toContain(
      "If you know which app this is, ask its support whether it has moved to an app embed.",
    );
    expect(cloudfront?.description).not.toContain("that app");
  });

  it("produces the same snippets in the same order whatever the input order", () => {
    const a = detectScriptTagSunset(PAW_URLS, NO_EMBEDS, BEFORE);
    const b = detectScriptTagSunset([...PAW_URLS].reverse(), NO_EMBEDS, BEFORE);
    expect(b).toEqual(a);
  });

  it("names a cdn.shopify.com ScriptTag as a script hosted on Shopify's CDN", () => {
    const [f] = detectScriptTagSunset(
      ["https://cdn.shopify.com/s/files/1/0001/t/1/assets/app.js?v=123"],
      NO_EMBEDS,
      BEFORE,
    );
    expect(f.appName).toBeUndefined();
    expect(f.severity).toBe(Severity.HIGH);
    expect(f.codeSnippet).toBe(
      "script-tags: host cdn.shopify.com\nhttps://cdn.shopify.com/s/files/<shop>/t/1/assets/app.js",
    );
    expect(f.description).toBe(
      "A script hosted on Shopify's CDN, added by one of your apps, is loaded through a script tag. Shopify will stop running script tags on March 1, 2027, so whatever that script does on your store will stop working unless the app that added it moves to an app embed before then. If you know which app this is, ask its support whether it has moved to an app embed.",
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

    it("unmatched host copy: future one millisecond before the cutoff", () => {
      const [f] = detectScriptTagSunset(["https://x.vendor.io/a.js"], NO_EMBEDS, justBefore);
      expect(f.description).toBe(
        "A script from x.vendor.io, added by one of your apps, is loaded through a script tag. Shopify will stop running script tags on March 1, 2027, so whatever that script does on your store will stop working unless the app that added it moves to an app embed before then. If you know which app this is, ask its support whether it has moved to an app embed.",
      );
    });

    it("unmatched host copy: past tense exactly at the cutoff", () => {
      const [f] = detectScriptTagSunset(["https://x.vendor.io/a.js"], NO_EMBEDS, exactly);
      expect(f.description).toBe(
        "A script from x.vendor.io, added by one of your apps, is loaded through a script tag. Shopify stopped running script tags on March 1, 2027, so whatever that script does on your store has stopped working unless the app that added it has moved to an app embed. If you know which app this is, ask its support whether it has moved to an app embed.",
      );
      expect(f.severity).toBe(Severity.HIGH);
    });

    it("Shopify CDN copy: past tense after the cutoff", () => {
      const [f] = detectScriptTagSunset(
        ["https://cdn.shopify.com/s/files/1/0001/t/1/assets/app.js"],
        NO_EMBEDS,
        AFTER,
      );
      expect(f.description).toBe(
        "A script hosted on Shopify's CDN, added by one of your apps, is loaded through a script tag. Shopify stopped running script tags on March 1, 2027, so whatever that script does on your store has stopped working unless the app that added it has moved to an app embed. If you know which app this is, ask its support whether it has moved to an app embed.",
      );
    });

    it("unmatched host copy stays HIGH wording even when embeds are enabled (it can never be LOW)", () => {
      const [f] = detectScriptTagSunset(
        ["https://x.vendor.io/a.js"],
        new Set(["x.vendor.io", "Klaviyo"]),
        justBefore,
      );
      expect(f.severity).toBe(Severity.HIGH);
      expect(f.description).not.toContain("embed turned on");
      expect(f.description).toMatch(/^A script from x\.vendor\.io, added by one of your apps/);
    });
  });

  describe("stable identity (fingerprint)", () => {
    const fp = (f: {
      filename: string;
      findingType: string;
      codeSnippet: string;
      lineNumber: number;
    }) => fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);

    it("keeps the same fingerprint when a vendor bumps a script version", () => {
      const [v1] = detectScriptTagSunset(
        ["https://d5zu2f4xvqanl.cloudfront.net/42/fe/loader_2.js"],
        NO_EMBEDS,
        BEFORE,
      );
      const [v2] = detectScriptTagSunset(
        ["https://d5zu2f4xvqanl.cloudfront.net/42/fe/loader_3.js"],
        NO_EMBEDS,
        BEFORE,
      );
      expect(v2.codeSnippet).not.toBe(v1.codeSnippet);
      expect(fp(v2)).toBe(fp(v1));
    });

    it("keeps the same fingerprint when a URL that sorts first is added to the group", () => {
      const [before] = detectScriptTagSunset(
        ["https://static.klaviyo.com/onsite/js/klaviyo.js"],
        NO_EMBEDS,
        BEFORE,
      );
      const [after] = detectScriptTagSunset(
        ["https://static.klaviyo.com/onsite/js/klaviyo.js", "https://a.klaviyo.com/a.js"],
        NO_EMBEDS,
        BEFORE,
      );
      expect(after.codeSnippet.split("\n")[1]).toBe("https://a.klaviyo.com/a.js");
      expect(fp(after)).toBe(fp(before));
    });

    it("gives different groups different fingerprints", () => {
      const prints = detectScriptTagSunset(PAW_URLS, NO_EMBEDS, BEFORE).map(fp);
      expect(new Set(prints).size).toBe(prints.length);
    });
  });

  describe("caps", () => {
    const hostUrl = (i: number) => `https://h${i}.vendor-${i}.io/a.js`;

    it(`reads at most ${MAX_SCRIPT_TAG_URLS} URLs from the list`, () => {
      expect(MAX_SCRIPT_TAG_URLS).toBe(200);
      // Entries 0-199 on one host, 200-249 on another: the second host is past
      // the cap, so it never becomes a finding.
      const urls = Array.from({ length: 250 }, (_, i) =>
        i < 200 ? `https://cdn.first.io/${i}.js` : `https://cdn.second.io/${i}.js`,
      );
      const findings = detectScriptTagSunset(urls, NO_EMBEDS, BEFORE);
      expect(findings.map((f) => f.codeSnippet.split("\n")[0])).toEqual([
        "script-tags: host cdn.first.io",
      ]);
    });

    it(`drops URLs longer than ${MAX_SCRIPT_TAG_URL_LENGTH} characters`, () => {
      expect(MAX_SCRIPT_TAG_URL_LENGTH).toBe(500);
      const long = `https://cdn.long.io/${"a".repeat(500)}.js`;
      expect(detectScriptTagSunset([long], NO_EMBEDS, BEFORE)).toEqual([]);
      const okLen = `https://cdn.ok.io/${"a".repeat(400)}.js`;
      expect(detectScriptTagSunset([okLen], NO_EMBEDS, BEFORE)).toHaveLength(1);
    });

    it(`emits at most ${MAX_SCRIPT_TAG_GROUPS} findings, the same ones whatever the order`, () => {
      expect(MAX_SCRIPT_TAG_GROUPS).toBe(25);
      const urls = Array.from({ length: 40 }, (_, i) => hostUrl(i));
      const a = detectScriptTagSunset(urls, NO_EMBEDS, BEFORE);
      const b = detectScriptTagSunset([...urls].reverse(), NO_EMBEDS, BEFORE);
      expect(a).toHaveLength(25);
      expect(b).toEqual(a);
    });

    it("truncates codeSnippet to 300 characters, keeping the group key line", () => {
      const urls = Array.from(
        { length: 20 },
        (_, i) => `https://cdn.unknown.io/path/${i}/script.js`,
      );
      const [f] = detectScriptTagSunset(urls, NO_EMBEDS, BEFORE);
      expect(f.codeSnippet.length).toBeLessThanOrEqual(300);
      expect(f.codeSnippet.split("\n")[0]).toBe("script-tags: host cdn.unknown.io");
    });

    it("truncates a very long host in the description and the key line", () => {
      const label = "a".repeat(60);
      const host = `${label}.${label}.${label}.example.com`;
      const [f] = detectScriptTagSunset([`https://${host}/a.js`], NO_EMBEDS, BEFORE);
      expect(f.description).not.toContain(host);
      const named = f.description.match(/^A script from (\S+), added/)?.[1] ?? "";
      expect(named.length).toBeLessThanOrEqual(100);
      expect(f.codeSnippet.split("\n")[0].length).toBeLessThanOrEqual(120);
    });
  });

  it("HIGH copy never claims the app has no app embed", () => {
    for (const now of [BEFORE, AFTER]) {
      for (const f of detectScriptTagSunset(PAW_URLS, NO_EMBEDS, now)) {
        expect(f.severity).toBe(Severity.HIGH);
        expect(f.description.toLowerCase()).not.toMatch(
          /(no|without an?|doesn't have an?) (app )?embed/,
        );
        expect(f.description).not.toContain("embed turned on");
      }
    }
  });

  describe("embed evidence for review apps (verified handles)", () => {
    it("Judge.me ScriptTag is LOW with the judge-me-reviews embed enabled", () => {
      const [f] = detectScriptTagSunset(
        ["https://cdn.judge.me/loader.js"],
        new Set(["Judge.me"]),
        BEFORE,
      );
      expect(f.appName).toBe("Judge.me");
      expect(f.severity).toBe(Severity.LOW);
    });

    it("attributes a cdn2.ryviu.com ScriptTag to Ryviu", () => {
      const [f] = detectScriptTagSunset(
        ["https://cdn2.ryviu.com/v/static/js/app.js?shop=x"],
        new Set(["Ryviu"]),
        BEFORE,
      );
      expect(f.appName).toBe("Ryviu");
      expect(f.severity).toBe(Severity.LOW);
    });

    it("groups Rise.ai's two ScriptTag hosts into one Rise.ai finding", () => {
      const findings = detectScriptTagSunset(
        [`https://str.rise-ai.com/?shop=${SHOP}`, `https://strn.rise-ai.com/?shop=${SHOP}`],
        NO_EMBEDS,
        BEFORE,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].appName).toBe("Rise.ai");
      expect(findings[0].codeSnippet.split("\n")).toEqual([
        "script-tags: Rise.ai",
        "https://str.rise-ai.com/",
        "https://strn.rise-ai.com/",
      ]);
    });
  });

  describe("shop file bucket redaction (cdn.shopify.com)", () => {
    const snippetUrls = (f: { codeSnippet: string }) => f.codeSnippet.split("\n").slice(1);

    it("replaces the numeric file-bucket id with <shop> in stored URLs", () => {
      const [f] = detectScriptTagSunset(
        ["https://cdn.shopify.com/s/files/1/0013/1642/1703/t/1/assets/x.js?v=99"],
        NO_EMBEDS,
        BEFORE,
      );
      expect(snippetUrls(f)).toEqual(["https://cdn.shopify.com/s/files/<shop>/t/1/assets/x.js"]);
      expect(f.codeSnippet).not.toMatch(/0013|1642|1703/);
    });

    it("keeps the group key line (and so the fingerprint) unchanged", () => {
      const [f] = detectScriptTagSunset(
        ["https://cdn.shopify.com/s/files/1/0013/1642/1703/t/1/assets/x.js"],
        NO_EMBEDS,
        BEFORE,
      );
      expect(f.codeSnippet.split("\n")[0]).toBe("script-tags: host cdn.shopify.com");
      expect(fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber)).toBe(
        fingerprintFinding(
          SCRIPT_TAG_FINDING_FILENAME,
          FindingType.SCRIPT_TAG_SUNSET,
          "script-tags: host cdn.shopify.com\nhttps://cdn.shopify.com/s/files/1/0013/1642/1703/t/1/assets/x.js",
          1,
        ),
      );
    });

    it("never collapses two different files of the same shop into one", () => {
      const [f] = detectScriptTagSunset(
        [
          "https://cdn.shopify.com/s/files/1/0013/1642/1703/t/1/assets/x.js",
          "https://cdn.shopify.com/s/files/1/0013/1642/1703/t/1/assets/y.js",
          "https://cdn.shopify.com/s/files/1/0013/1642/1703/t/2/assets/x.js",
          "https://cdn.shopify.com/s/files/1/0013/1642/1703/files/x.js",
        ],
        NO_EMBEDS,
        BEFORE,
      );
      expect(snippetUrls(f)).toEqual([
        "https://cdn.shopify.com/s/files/<shop>/files/x.js",
        "https://cdn.shopify.com/s/files/<shop>/t/1/assets/x.js",
        "https://cdn.shopify.com/s/files/<shop>/t/1/assets/y.js",
        "https://cdn.shopify.com/s/files/<shop>/t/2/assets/x.js",
      ]);
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
