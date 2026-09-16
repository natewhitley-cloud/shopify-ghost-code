/**
 * Tests for the third-party domain graph collector (Feature 1 of the
 * scan-observability spec).
 *
 * collectThirdPartyDomains is pure — no mocks. Cross-file aggregation is tested
 * through scanThemeFiles (which drives the per-host union + refCount sum).
 */

import { describe, it, expect } from "vitest";

import {
  collectThirdPartyDomains,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function domainByHost(refs: ReturnType<typeof collectThirdPartyDomains>, host: string) {
  return refs.find((r) => r.domain === host);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("collectThirdPartyDomains — classification", () => {
  it("excludes Shopify first-party hosts entirely", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: `
        <script src="https://cdn.shopify.com/s/files/app.js"></script>
        <script src="https://foo.shopifycdn.com/x.js"></script>
        <link rel="preconnect" href="https://cdn.shopifycdn.net">
      `,
    };
    const refs = collectThirdPartyDomains(file);
    expect(refs).toEqual([]);
  });

  it("classifies a known app host as matched with an appName", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: `<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>`,
    };
    const refs = collectThirdPartyDomains(file);
    const klaviyo = domainByHost(refs, "static.klaviyo.com");
    expect(klaviyo).toBeDefined();
    expect(klaviyo).toMatchObject({
      matched: true,
      appName: "Klaviyo",
      benign: false,
      sources: ["script"],
      refCount: 1,
    });
  });

  it("classifies a known benign public-CDN library as benign (not matched)", () => {
    const file: ThemeFile = {
      filename: "sections/a.liquid",
      content: `<script src="https://cdn.jsdelivr.net/npm/swiper@8/swiper.min.js"></script>`,
    };
    const refs = collectThirdPartyDomains(file);
    const jsdelivr = domainByHost(refs, "cdn.jsdelivr.net");
    expect(jsdelivr).toBeDefined();
    expect(jsdelivr).toMatchObject({
      matched: false,
      appName: null,
      benign: true,
    });
  });

  it("classifies a shared-CDN host as benign via isSharedCdnDomain (not isBenignLibrary)", () => {
    // cdnjs.cloudflare.com is a SHARED_CDN_DOMAIN but is NOT a suppression source
    // for isBenignLibrary (cdnjs is excluded there), so this exercises the
    // isSharedCdnDomain branch of the benign classification specifically.
    const file: ThemeFile = {
      filename: "sections/a.liquid",
      content: `<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>`,
    };
    const refs = collectThirdPartyDomains(file);
    const cdnjs = domainByHost(refs, "cdnjs.cloudflare.com");
    expect(cdnjs).toBeDefined();
    expect(cdnjs).toMatchObject({
      matched: false,
      appName: null,
      benign: true,
    });
  });

  it("keeps an unknown host as a flywheel candidate (neither matched nor benign)", () => {
    const file: ThemeFile = {
      filename: "sections/a.liquid",
      content: `<script src="https://api.unknownvendor.io/track.js"></script>`,
    };
    const refs = collectThirdPartyDomains(file);
    const unknown = domainByHost(refs, "api.unknownvendor.io");
    expect(unknown).toBeDefined();
    expect(unknown).toMatchObject({
      matched: false,
      appName: null,
      benign: false,
      refCount: 1,
    });
  });

  it("skips malformed URLs that the regex captures but the URL parser rejects", () => {
    const file: ThemeFile = {
      filename: "sections/a.liquid",
      content: `<script src="https:// not a host"></script>`,
    };
    const refs = collectThirdPartyDomains(file);
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

describe("collectThirdPartyDomains — surfaces", () => {
  it("captures preconnect and dns-prefetch as distinct sources", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: `
        <link rel="preconnect" href="https://a.example.com">
        <link rel="dns-prefetch" href="https://b.example.com">
      `,
    };
    const refs = collectThirdPartyDomains(file);
    expect(domainByHost(refs, "a.example.com")?.sources).toEqual(["preconnect"]);
    expect(domainByHost(refs, "b.example.com")?.sources).toEqual(["dns_prefetch"]);
  });

  it("captures @font-face src URLs and fetch/XHR/AJAX URL literals", () => {
    const file: ThemeFile = {
      filename: "sections/a.liquid",
      content: `
        <style>
          @font-face { font-family: "X"; src: url("https://fonts.acme.io/x.woff2"); }
        </style>
        <script>
          fetch("https://api.acme-ajax.io/data");
        </script>
      `,
    };
    const refs = collectThirdPartyDomains(file);
    expect(domainByHost(refs, "fonts.acme.io")?.sources).toEqual(["font"]);
    expect(domainByHost(refs, "api.acme-ajax.io")?.sources).toEqual(["ajax"]);
  });

  it("unions multiple sources and sums refCount for the same host within a file", () => {
    const file: ThemeFile = {
      filename: "sections/a.liquid",
      content: `
        <script src="https://dup.example.com/one.js"></script>
        <script src="https://dup.example.com/two.js"></script>
        <link rel="dns-prefetch" href="https://dup.example.com">
      `,
    };
    const refs = collectThirdPartyDomains(file);
    const dup = domainByHost(refs, "dup.example.com");
    expect(dup?.refCount).toBe(3);
    expect(dup?.sources).toEqual(["dns_prefetch", "script"]);
  });
});

// ---------------------------------------------------------------------------
// <link> tag precedence — at most one surface per physical tag
// ---------------------------------------------------------------------------

describe("collectThirdPartyDomains — <link> tag precedence", () => {
  it("counts a Google Fonts stylesheet <link> once as stylesheet (not also font)", () => {
    // This href matches BOTH LINK_STYLESHEET_RE and FONT_LINK_RE. Precedence
    // stylesheet > font must record a single stylesheet surface, refCount 1 —
    // NOT refCount 2 with sources ["font","stylesheet"].
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`,
    };
    const refs = collectThirdPartyDomains(file);
    const font = domainByHost(refs, "fonts.googleapis.com");
    expect(font).toBeDefined();
    expect(font).toMatchObject({
      refCount: 1,
      sources: ["stylesheet"],
      benign: true,
    });
  });

  it("counts a preconnect to a font host once as preconnect (no phantom font)", () => {
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    };
    const refs = collectThirdPartyDomains(file);
    const font = domainByHost(refs, "fonts.googleapis.com");
    expect(font).toBeDefined();
    expect(font).toMatchObject({
      refCount: 1,
      sources: ["preconnect"],
    });
  });

  it("still records a font-only <link> (matches FONT_LINK_RE, not stylesheet/preconnect)", () => {
    // No rel=stylesheet and no rel=preconnect/dns-prefetch, so only FONT_LINK_RE
    // matches (href contains "font"). Proves the font branch is not dead.
    const file: ThemeFile = {
      filename: "layout/theme.liquid",
      content: `<link href="https://cdn.example.com/webfont.css">`,
    };
    const refs = collectThirdPartyDomains(file);
    const host = domainByHost(refs, "cdn.example.com");
    expect(host).toBeDefined();
    expect(host).toMatchObject({
      refCount: 1,
      sources: ["font"],
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-file aggregation (via scanThemeFiles)
// ---------------------------------------------------------------------------

describe("scanThemeFiles — third-party domain aggregation", () => {
  it("unions sources and sums refCount for a host referenced across multiple files", () => {
    const files: ThemeFile[] = [
      {
        filename: "sections/one.liquid",
        content: `<script src="https://shared.example.com/a.js"></script>`,
      },
      {
        filename: "snippets/two.liquid",
        content: `<link rel="preconnect" href="https://shared.example.com">`,
      },
    ];
    const result = scanThemeFiles(files);
    const shared = result.thirdPartyDomains?.find((d) => d.domain === "shared.example.com");
    expect(shared).toBeDefined();
    expect(shared?.refCount).toBe(2);
    expect(shared?.sources).toEqual(["preconnect", "script"]);
    expect(shared?.matched).toBe(false);
    expect(shared?.benign).toBe(false);
  });

  it("lets matched win over benign when a host is benign in one file and app-matched in another", () => {
    // File one loads a benign jsdelivr library; file two loads a jsdelivr URL
    // whose path matches an app scriptPattern (klaviyo.js). The final row must
    // be matched=true with the appName and benign=false — matched wins.
    const files: ThemeFile[] = [
      {
        filename: "sections/one.liquid",
        content: `<script src="https://cdn.jsdelivr.net/npm/swiper@8/swiper.min.js"></script>`,
      },
      {
        filename: "snippets/two.liquid",
        content: `<script src="https://cdn.jsdelivr.net/npm/klaviyo.js"></script>`,
      },
    ];
    const result = scanThemeFiles(files);
    const rows = result.thirdPartyDomains?.filter((d) => d.domain === "cdn.jsdelivr.net") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      matched: true,
      appName: "Klaviyo",
      benign: false,
      refCount: 2,
    });
  });

  it("deduplicates hosts and preserves the matched/appName classification across files", () => {
    const files: ThemeFile[] = [
      {
        filename: "sections/one.liquid",
        content: `<script src="https://static.klaviyo.com/a.js"></script>`,
      },
      {
        filename: "snippets/two.liquid",
        content: `<script src="https://static.klaviyo.com/b.js"></script>`,
      },
    ];
    const result = scanThemeFiles(files);
    const klaviyoRows =
      result.thirdPartyDomains?.filter((d) => d.domain === "static.klaviyo.com") ?? [];
    expect(klaviyoRows).toHaveLength(1);
    expect(klaviyoRows[0]).toMatchObject({
      matched: true,
      appName: "Klaviyo",
      benign: false,
      refCount: 2,
    });
  });
});
