/**
 * Runtime malicious check (gc-0htk): the known-malicious list matched against
 * the served homepage HTML and the speed test's request URLs. Pure functions,
 * no network, no DB.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/models/finding.server", () => ({
  getFindingsForScan: vi.fn(),
  getTopFindingsOfTypes: vi.fn(),
}));

import {
  homepageMaliciousDescription,
  KNOWN_MALICIOUS_DOMAINS,
  maliciousDescription,
} from "../../app/data/malicious-domains.server";
import {
  HOMEPAGE_MALICIOUS_FILENAME,
  isHomepageMaliciousFinding,
  NEVER_PAYWALLED_FINDING_TYPES,
} from "../../app/lib/finding-classification";
import {
  buildRemovalInstructions,
  getFindingCardCopy,
  getFindingImpact,
  getFindingRemediation,
  RUNTIME_MALICIOUS_STEPS,
} from "../../app/lib/finding-remediation";
import { pickFreePreviewFindings } from "../../app/lib/free-preview";
import { findingLocation, toTopFindingViews } from "../../app/lib/top-findings";
import { getTopFindingsOfTypes } from "../../app/models/finding.server";
import { getFreePreviewFindings } from "../../app/services/free-preview.server";
import {
  findMaliciousInHomepage,
  HOMEPAGE_SOURCE_LABELS,
  homepageMaliciousFindings,
  maliciousDomainsInUrls,
  MAX_HOMEPAGE_MALICIOUS_FINDINGS,
  themeMaliciousDomains,
} from "../../app/services/runtime-malicious.server";
import { buildSecurityRisks } from "../../app/services/security-risk.server";

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const entry = (domain: string) => KNOWN_MALICIOUS_DOMAINS.find((d) => d.domain === domain)!;

describe("findMaliciousInHomepage: where on the page", () => {
  it("finds a <script src> on a listed host, subdomain included", () => {
    expect(
      findMaliciousInHomepage(
        page('<script src="https://www.biliing.top/check-out/x.js"></script>'),
        [],
      ),
    ).toEqual([{ domain: "biliing.top", host: "www.biliing.top", source: "script" }]);
  });

  it("finds a protocol-relative, unquoted or single-quoted src, any attribute order", () => {
    for (const tag of [
      "<script async src=//cdn.checkout-guard.top/a.js></script>",
      "<script defer='defer' src='https://checkout-guard.top/a.js'></script>",
      '<SCRIPT TYPE="text/javascript" SRC="https://CHECKOUT-GUARD.TOP/a.js"></SCRIPT>',
    ]) {
      expect(
        findMaliciousInHomepage(page(tag), []).map((h) => h.domain),
        tag,
      ).toEqual(["checkout-guard.top"]);
    }
  });

  it("finds a host named in inline JavaScript, JSON-escaped slashes included", () => {
    const html = page(
      '<script>window.location.href = "https:\\/\\/account-confirm.top\\/login";</script>',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([
      { domain: "account-confirm.top", host: "account-confirm.top", source: "inline_script" },
    ]);
  });

  it("finds an app script tag (asyncLoad url passed by the fetcher)", () => {
    expect(
      findMaliciousInHomepage(page(""), ["https://cdn.billing-confirm.top/s.js?shop=x"]),
    ).toEqual([
      { domain: "billing-confirm.top", host: "cdn.billing-confirm.top", source: "script_tag" },
    ]);
  });

  it("finds the asyncLoad block itself too, reported as the script tag (most specific source)", () => {
    const block =
      '<script>function asyncLoad(){var urls = ["https:\\/\\/cdn.billing-confirm.top\\/s.js"];}</script>';
    expect(findMaliciousInHomepage(page(block), ["https://cdn.billing-confirm.top/s.js"])).toEqual([
      { domain: "billing-confirm.top", host: "cdn.billing-confirm.top", source: "script_tag" },
    ]);
  });

  it("finds a <link href> (stylesheet, preload)", () => {
    expect(
      findMaliciousInHomepage(
        page('<link rel="preload" as="script" href="https://order-confirm.top/p.js">'),
        [],
      ),
    ).toEqual([{ domain: "order-confirm.top", host: "order-confirm.top", source: "link" }]);
  });

  it("one hit per listed domain, sorted, keeping the most specific source", () => {
    const html = page(
      [
        '<script>var u = "https://biliing.top/x";</script>',
        '<link rel="stylesheet" href="https://biliing.top/a.css">',
        '<script src="https://cdn.jsdeliver.cloud/x.js"></script>',
        '<script src="https://www.biliing.top/x.js"></script>',
      ].join(""),
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([
      { domain: "biliing.top", host: "www.biliing.top", source: "script" },
      { domain: "jsdeliver.cloud", host: "cdn.jsdeliver.cloud", source: "script" },
    ]);
  });
});

describe("findMaliciousInHomepage: precision", () => {
  it("never matches a lookalike host", () => {
    const html = page(
      [
        '<script src="https://billing.top/x.js"></script>',
        '<script src="https://notbiliing.top/x.js"></script>',
        '<script src="https://biliing.top.example.com/x.js"></script>',
        '<script src="https://checkout-guard.com/x.js"></script>',
        '<script src="https://accountconfirm.top/x.js"></script>',
      ].join(""),
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([]);
  });

  it("ignores a reference inside an HTML comment, for every entry (it does not load)", () => {
    for (const domain of ["biliing.top", "polyfill.io", "checkout-guard.top"]) {
      const html = page(`<!-- <script src="https://cdn.${domain}/x.js"></script> -->`);
      expect(findMaliciousInHomepage(html, []), domain).toEqual([]);
    }
  });

  it("ignores a reference inside a JS comment in an inline script", () => {
    const html = page(
      '<script>\n// var a = "https://biliing.top/x";\n/* load("https://checkout-guard.top/y") */\nvar ok = 1;\n</script>',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([]);
  });

  it("still reports live code on the same line as a comment", () => {
    const html = page('<script>/* old */ load("https://checkout-guard.top/y");</script>');
    expect(findMaliciousInHomepage(html, []).map((h) => h.domain)).toEqual(["checkout-guard.top"]);
  });

  it("ignores page text, links, images and JSON data blocks (they load no code)", () => {
    const html = page(
      '<script type="application/ld+json">{"url":"https://biliing.top/x"}</script><script type="application/json">{"u":"https://biliing.top/x"}</script>',
      '<p>Beware of https://biliing.top/check-out/</p><a href="https://biliing.top/">x</a><img src="https://biliing.top/i.png">',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([]);
  });

  it("a `<link` written inside JavaScript is not a tag (the inline script reports it instead)", () => {
    const html = page(`<script>var t = '<link href="https://biliing.top/a.css">';</script>`);
    expect(findMaliciousInHomepage(html, [])).toEqual([
      { domain: "biliing.top", host: "biliing.top", source: "inline_script" },
    ]);
  });

  it("a URL in a query string of another host's src is not a load of it", () => {
    const html = page(
      '<script src="https://good.example.com/x.js?u=https://biliing.top/"></script>',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([]);
  });

  it("empty or clean input yields nothing; an unterminated tag stops the read", () => {
    expect(findMaliciousInHomepage("", [])).toEqual([]);
    expect(
      findMaliciousInHomepage(page('<script src="https://cdn.shopify.com/x.js"></script>'), []),
    ).toEqual([]);
    expect(findMaliciousInHomepage('<script src="https://biliing.top/x.js', [])).toEqual([]);
  });

  it("stays fast on a large page full of tags (linear)", () => {
    const html = page("<script>var a = 1;</script><link rel=x href=/y>".repeat(50_000));
    const started = Date.now();
    expect(findMaliciousInHomepage(html, [])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("findMaliciousInHomepage: audit fixes (gc-0htk)", () => {
  it("skips tags written inside inert or text-only elements", () => {
    for (const wrapper of ["textarea", "title", "template", "noscript", "style", "xmp"]) {
      const html = page(
        `<${wrapper}><script src="https://biliing.top/x.js"></script><link href="https://biliing.top/a.css"></${wrapper}>`,
      );
      expect(findMaliciousInHomepage(html, []), wrapper).toEqual([]);
    }
    // A live tag after the inert element is still read.
    const after = page(
      '<noscript><img src="x"></noscript><script src="https://biliing.top/x.js"></script>',
    );
    expect(findMaliciousInHomepage(after, []).map((h) => h.domain)).toEqual(["biliing.top"]);
  });

  it("reads inline scripts whose type carries MIME parameters or a legacy JS type", () => {
    for (const type of ["text/javascript; charset=utf-8", "text/x-javascript", "TEXT/JSCRIPT"]) {
      const html = page(`<script type="${type}">load("https://biliing.top/x");</script>`);
      expect(
        findMaliciousInHomepage(html, []).map((h) => h.domain),
        type,
      ).toEqual(["biliing.top"]);
    }
  });

  it("never matches or stores a host longer than a DNS name", () => {
    const long = `${"a".repeat(250)}.biliing.top`;
    expect(
      findMaliciousInHomepage(page(`<script src="https://${long}/x.js"></script>`), []),
    ).toEqual([]);
  });
});

// gc-3y89 item 3: a connection hint is named, not loaded; frames, forms and
// import maps are read too. A URL in a JS string still counts (recall over
// precision for this curated list); the label says "Named in JavaScript".
describe("findMaliciousInHomepage: hints, frames, forms, import maps (gc-3y89 #3)", () => {
  it.each([
    '<link rel="preconnect" href="https://order-confirm.top">',
    '<link rel="dns-prefetch" href="//order-confirm.top">',
    '<link rel="preconnect dns-prefetch" href="https://order-confirm.top" crossorigin>',
    '<link href="https://order-confirm.top" REL="DNS-Prefetch">',
  ])("reports a connection hint as a hint, not a load: %s", (tag) => {
    expect(findMaliciousInHomepage(page(tag), [])).toEqual([
      { domain: "order-confirm.top", host: "order-confirm.top", source: "hint" },
    ]);
  });

  it("a link that loads (stylesheet, preload, no rel) stays a load", () => {
    for (const tag of [
      '<link rel="stylesheet" href="https://order-confirm.top/a.css">',
      '<link rel="preconnect stylesheet" href="https://order-confirm.top/a.css">',
      '<link href="https://order-confirm.top/a.css">',
    ]) {
      expect(findMaliciousInHomepage(page(tag), [])[0].source, tag).toBe("link");
    }
  });

  it("a load outranks a hint for the same domain", () => {
    const html = page(
      '<link rel="preconnect" href="https://order-confirm.top"><script src="https://order-confirm.top/x.js"></script>',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([
      { domain: "order-confirm.top", host: "order-confirm.top", source: "script" },
    ]);
  });

  it("reads an iframe src and skips the iframe's fallback text", () => {
    const html = page(
      "",
      '<iframe src="https://pay.checkout-guard.top/frame"><script src="https://biliing.top/x.js"></script></iframe>',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([
      { domain: "checkout-guard.top", host: "pay.checkout-guard.top", source: "iframe" },
    ]);
  });

  it("reads a form action and keeps reading the form's own tags", () => {
    const html = page(
      "",
      '<form method="post" action="https://account-confirm.top/collect"><input name="card"><script src="https://biliing.top/x.js"></script></form>',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([
      { domain: "account-confirm.top", host: "account-confirm.top", source: "form" },
      { domain: "biliing.top", host: "biliing.top", source: "script" },
    ]);
  });

  it("a relative form action or iframe src names no host", () => {
    const html = page("", '<form action="/cart/add"></form><iframe src="/pages/x"></iframe>');
    expect(findMaliciousInHomepage(html, [])).toEqual([]);
  });

  it("reads the URLs in an import map", () => {
    const html = page(
      '<script type="importmap">{"imports":{"lib":"https:\\/\\/cdn.jsdeliver.cloud\\/lib.js"}}</script>',
    );
    expect(findMaliciousInHomepage(html, [])).toEqual([
      { domain: "jsdeliver.cloud", host: "cdn.jsdeliver.cloud", source: "importmap" },
    ]);
  });

  it("does not read a <formula> look-alike tag as a form", () => {
    const html = page("", '<formula action="https://biliing.top/x"></formula>');
    expect(findMaliciousInHomepage(html, [])).toEqual([]);
  });

  it("still reports a URL inside a JavaScript string, labelled as named in JavaScript", () => {
    const html = page('<script>var msg = "see https://biliing.top/help";</script>');
    const hits = findMaliciousInHomepage(html, []);
    expect(hits).toEqual([{ domain: "biliing.top", host: "biliing.top", source: "inline_script" }]);
    expect(homepageMaliciousFindings(hits, new Set())[0].codeSnippet).toBe(
      "biliing.top\nNamed in JavaScript in the page: biliing.top",
    );
  });

  it("labels a hint as named, never as loaded", () => {
    const hits = findMaliciousInHomepage(
      page('<link rel="dns-prefetch" href="https://order-confirm.top">'),
      [],
    );
    const snippet = homepageMaliciousFindings(hits, new Set())[0].codeSnippet;
    expect(snippet).toBe(
      "order-confirm.top\nNamed in a connection hint in the page: order-confirm.top",
    );
    expect(snippet).not.toContain("Loaded");
  });

  it("every source has a label with no em dash", () => {
    for (const label of Object.values(HOMEPAGE_SOURCE_LABELS)) {
      expect(label).not.toContain("\u2014");
    }
  });
});

describe("maliciousDomainsInUrls (speed test requests)", () => {
  it("returns the listed domains, de-duplicated and sorted, subdomains included", () => {
    expect(
      maliciousDomainsInUrls([
        "https://www.biliing.top/check-out/",
        "https://cdn.shopify.com/s/x.js",
        "http://checkout-guard.top/a",
        "https://biliing.top/api/submissions",
      ]),
    ).toEqual(["biliing.top", "checkout-guard.top"]);
  });

  it("skips lookalikes, non-http URLs, non-strings and garbage", () => {
    expect(
      maliciousDomainsInUrls([
        "https://billing.top/x",
        "https://checkout-guard.com/x",
        "data:text/javascript,https://biliing.top",
        "not a url",
        42,
        null,
      ]),
    ).toEqual([]);
    expect(maliciousDomainsInUrls([])).toEqual([]);
  });
});

describe("homepageMaliciousFindings", () => {
  const hits = [
    { domain: "biliing.top", host: "www.biliing.top", source: "script_tag" as const },
    {
      domain: "jsdeliver.cloud",
      host: "shopify.jsdeliver.cloud",
      source: "inline_script" as const,
    },
  ];

  it("builds one HIGH MALICIOUS_SCRIPT finding per domain, filed under the homepage", () => {
    expect(homepageMaliciousFindings(hits, new Set())).toEqual([
      {
        filename: HOMEPAGE_MALICIOUS_FILENAME,
        lineNumber: 0,
        codeSnippet: "biliing.top\nLoaded by a script tag an app added: www.biliing.top",
        findingType: "MALICIOUS_SCRIPT",
        severity: "HIGH",
        description: homepageMaliciousDescription(entry("biliing.top")),
      },
      {
        filename: HOMEPAGE_MALICIOUS_FILENAME,
        lineNumber: 0,
        codeSnippet: "jsdeliver.cloud\nNamed in JavaScript in the page: shopify.jsdeliver.cloud",
        findingType: "MALICIOUS_SCRIPT",
        severity: "HIGH",
        description: homepageMaliciousDescription(entry("jsdeliver.cloud")),
      },
    ]);
  });

  it("drops domains the theme files already report", () => {
    const theme = themeMaliciousDomains([maliciousDescription(entry("biliing.top")), "unrelated"]);
    expect(theme).toEqual(new Set(["biliing.top"]));
    expect(homepageMaliciousFindings(hits, theme).map((f) => f.codeSnippet.split("\n")[0])).toEqual(
      ["jsdeliver.cloud"],
    );
  });

  it("is capped", () => {
    const many = Array.from({ length: 40 }, () => hits[0]);
    expect(homepageMaliciousFindings(many, new Set())).toHaveLength(
      MAX_HOMEPAGE_MALICIOUS_FINDINGS,
    );
  });

  it("the description says where it was seen, never asks to remove a theme reference", () => {
    for (const d of KNOWN_MALICIOUS_DOMAINS) {
      const text = homepageMaliciousDescription(d);
      expect(text, d.domain).toContain("Your live homepage");
      expect(text, d.domain).toContain("not in your theme files");
      expect(text, d.domain).not.toMatch(/[–—]/);
      expect(text, d.domain).not.toMatch(/\.$/);
      expect(text, d.domain).not.toBe(maliciousDescription(d));
    }
  });
});

describe("homepage finding copy (never sends the merchant to theme files)", () => {
  const [finding] = homepageMaliciousFindings(
    [{ domain: "biliing.top", host: "www.biliing.top", source: "script" }],
    new Set(),
  );

  it("is recognised by type + filename only", () => {
    expect(isHomepageMaliciousFinding(finding)).toBe(true);
    expect(isHomepageMaliciousFinding({ ...finding, filename: "layout/theme.liquid" })).toBe(false);
    expect(isHomepageMaliciousFinding({ ...finding, findingType: "LIQUID_ERROR_RENDERED" })).toBe(
      false,
    );
  });

  it("card, impact, how-to and copied steps are the runtime 'what to check' steps", () => {
    const card = getFindingCardCopy(finding.findingType, finding.filename);
    expect(card.steps).toEqual(RUNTIME_MALICIOUS_STEPS);
    expect(card.stepsHeading).toBe("What to check");
    expect(card.primaryEditorButton).toBe(false);
    expect(card.showSafetyBadge).toBe(false);
    const texts = [
      ...RUNTIME_MALICIOUS_STEPS,
      getFindingImpact(finding.findingType, finding.filename)!,
      getFindingRemediation(finding.findingType, finding.filename),
      buildRemovalInstructions(finding, "Malicious Scripts"),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/search (the rest of )?the theme|code editor|flagged line/i);
      expect(text).not.toMatch(/[–—]/);
    }
    const copied = buildRemovalInstructions(finding, "Malicious Scripts");
    expect(copied).toContain("Location: your live storefront homepage (not in your theme files)");
    expect(copied).toContain("Loaded by a script tag in the page: www.biliing.top");
    expect(copied).not.toContain("File:");
    expect(findingLocation(finding)).toBe("Your live homepage (not in your theme files)");
    // Start here links it as "See what to check", keeping the type title.
    const [view] = toTopFindingViews(
      "scan-1",
      [{ ...finding, id: "hp", appName: null, createdAt: new Date(0) }] as never,
      false,
    );
    expect(view.linkLabel).toBe("See what to check");
    expect(view.title).toBeUndefined();
    const [themeView] = toTopFindingViews(
      "scan-1",
      [
        {
          ...finding,
          filename: "layout/theme.liquid",
          id: "t",
          appName: null,
          createdAt: new Date(0),
        },
      ] as never,
      false,
    );
    expect(themeView.linkLabel).toBeUndefined();
  });

  it("a theme-file malicious finding keeps its theme copy", () => {
    const card = getFindingCardCopy("MALICIOUS_SCRIPT", "layout/theme.liquid");
    expect(card.steps).toBeNull();
    expect(getFindingRemediation("MALICIOUS_SCRIPT", "layout/theme.liquid")).toContain(
      "Search the rest of the theme",
    );
  });
});

describe("never paywalled: a homepage hit reaches Free (gc-0htk)", () => {
  // Rides the ONE never-paywalled list: the finding IS a MALICIOUS_SCRIPT.
  // Proven non-vacuous: removing "MALICIOUS_SCRIPT" from
  // NEVER_PAYWALLED_FINDING_TYPES makes these fail (checked by hand).
  const [homepage] = homepageMaliciousFindings(
    [{ domain: "checkout-guard.top", host: "checkout-guard.top", source: "script_tag" }],
    new Set(),
  );
  const row = (id: string, f: { findingType: string; severity: string }, createdAt = 0) => ({
    ...f,
    id,
    filename: "x",
    lineNumber: 0,
    codeSnippet: "",
    description: "",
    appName: null,
    createdAt: new Date(createdAt),
  });

  it("MALICIOUS_SCRIPT is on the never-paywalled list", () => {
    expect(NEVER_PAYWALLED_FINDING_TYPES).toContain("MALICIOUS_SCRIPT");
  });

  it("never takes a Free preview slot and never raises the preview count", async () => {
    const kept = [
      row("hp", homepage),
      row("g1", { findingType: "GHOST_SCRIPT", severity: "LOW" }, 1),
      row("g2", { findingType: "GHOST_SCRIPT", severity: "LOW" }, 2),
    ];
    // 2 paywallable findings: 1 shown in full. The HIGH homepage hit, if it
    // were paywallable, would be counted (3 -> 1 shown) and picked first.
    const picked = await getFreePreviewFindings(
      "scan-1",
      { MALICIOUS_SCRIPT: 1, GHOST_SCRIPT: 2 },
      kept as never,
      [],
    );
    expect(picked.map((f) => f.id)).toEqual(["g1"]);
    expect(
      pickFreePreviewFindings(kept as never, 5).map((f) => (f as { id: string }).id),
    ).not.toContain("hp");
    expect(getTopFindingsOfTypes).not.toHaveBeenCalled();
  });

  it("is a Security risk banner on the scan's page whatever the plan, saying where it was seen", () => {
    const risks = buildSecurityRisks({
      advisories: [],
      malicious: [{ ...homepage, id: "hp" }],
      now: new Date("2026-10-20T00:00:00Z"),
    });
    expect(risks).toEqual([
      expect.objectContaining({
        kind: "malicious",
        seenIn: "homepage",
        domain: "checkout-guard.top",
        advice: null,
        findings: [{ id: "hp", filename: HOMEPAGE_MALICIOUS_FILENAME, lineNumber: 0 }],
      }),
    ]);
  });
});
