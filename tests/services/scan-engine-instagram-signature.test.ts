/**
 * The "Instagram Feed" signature must match only app-specific fingerprints.
 *
 * It used to list `instagram.com` as a cdnDomain (subdomain match), plus
 * `/window\.instgrm/`, `/instagramFeed/` and the generic `instagram-feed`
 * snippet/class name. So Instagram's OFFICIAL post embed, a theme's own call to
 * the Instagram Graph API, and a theme's own `instagram-feed` section were all
 * reported as orphaned code from an uninstalled "Instagram Feed" app.
 *
 * Kept fingerprints: LightWidget (cdn.lightwidget.com) and Instafeed by Mintt
 * (`instafeed` snippet/class, API host instafeed.nfcube.com, documented at
 * https://docs.minttstudio.com/developer-api/docs/instafeed-api/developer-api).
 */

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  identifyAppFromCode,
  identifyAppFromSnippetName,
  identifyAppFromUrl,
} from "../../app/services/app-lookup.server";
import {
  collectUnknownScripts,
  detectGhostAjax,
  detectGhostScripts,
  detectGhostSnippets,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";

const APP = "Instagram Feed";

function section(content: string): ThemeFile {
  return { filename: "sections/instagram.liquid", content };
}

describe("Instagram Feed signature: first-party Instagram code is not attributed", () => {
  const OFFICIAL_EMBED = '<script async src="//www.instagram.com/embed.js"></script>';

  it("does not flag Instagram's official embed.js as a GHOST_SCRIPT", () => {
    expect(detectGhostScripts(section(OFFICIAL_EMBED))).toEqual([]);
  });

  it("leaves the official embed.js unattributed (reported as an unknown script, not an app)", () => {
    // Without an app match the URL falls through to the unknown-script
    // collector, the same path as any other unrecognised third-party script.
    const unknowns = collectUnknownScripts(section(OFFICIAL_EMBED));
    expect(unknowns.map((u) => u.url)).toEqual(["//www.instagram.com/embed.js"]);
  });

  it("does not attribute instagram.com hosts to the app", () => {
    expect(identifyAppFromUrl("https://www.instagram.com/embed.js")).toBeNull();
    expect(identifyAppFromUrl("https://graph.instagram.com/me/media")).toBeNull();
  });

  it("does not flag a theme fetch to graph.instagram.com as GHOST_AJAX", () => {
    const content = [
      "<script>",
      "  if (window.instgrm) window.instgrm.Embeds.process();",
      "  const instagramFeed = document.querySelector('.instagram-feed');",
      '  fetch("https://graph.instagram.com/me/media?fields=id,media_url&access_token={{ section.settings.token }}")',
      "</script>",
    ].join("\n");
    expect(detectGhostAjax(section(content))).toEqual([]);
  });

  it("does not attribute window.instgrm or an instagramFeed variable", () => {
    expect(identifyAppFromCode("window.instgrm.Embeds.process();")).toBeNull();
    expect(identifyAppFromCode("const instagramFeed = [];")).toBeNull();
  });

  it("does not flag {% render 'instagram-feed' %} as a GHOST_SNIPPET", () => {
    expect(identifyAppFromSnippetName("instagram-feed")).toBeNull();
    expect(detectGhostSnippets(section("{% render 'instagram-feed' %}"))).toEqual([]);
  });

  it('does not attribute class="instagram-feed" markup', () => {
    expect(identifyAppFromCode('<div class="instagram-feed">')).toBeNull();
  });

  it("produces no Instagram Feed finding for a theme's own Instagram section end to end", () => {
    const files: ThemeFile[] = [
      section(
        [
          "{% render 'instagram-feed' %}",
          '<div class="instagram-feed">',
          '  <blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/abc/"></blockquote>',
          "</div>",
          '<script async src="//www.instagram.com/embed.js"></script>',
          "<script>",
          '  fetch("https://graph.instagram.com/me/media?fields=id")',
          "</script>",
        ].join("\n"),
      ),
      { filename: "snippets/instagram-feed.liquid", content: '<div class="instagram-feed"></div>' },
    ];
    const result = scanThemeFiles(files);
    expect(result.findings.filter((f) => f.appName === APP)).toEqual([]);
  });
});

describe("Instagram Feed signature: app-specific fingerprints still match", () => {
  it("flags a LightWidget script as Instagram Feed", () => {
    const findings = detectGhostScripts(
      section('<script src="https://cdn.lightwidget.com/widgets/lightwidget.js"></script>'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_SCRIPT);
    expect(findings[0].appName).toBe(APP);
  });

  it("flags {% render 'instafeed' %} as an Instagram Feed GHOST_SNIPPET", () => {
    const findings = detectGhostSnippets(section("{% render 'instafeed' %}"));
    expect(findings).toHaveLength(1);
    expect(findings[0].findingType).toBe(FindingType.GHOST_SNIPPET);
    expect(findings[0].appName).toBe(APP);
  });

  it("attributes the Instafeed API host instafeed.nfcube.com by hostname", () => {
    expect(identifyAppFromUrl("https://instafeed.nfcube.com/feed/v6?limit=10")).toBe(APP);
  });

  it("flags a fetch to instafeed.nfcube.com as an Instagram Feed GHOST_AJAX", () => {
    const findings = detectGhostAjax(
      section('<script>fetch("https://instafeed.nfcube.com/feed/v6?limit=10")</script>'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe(APP);
  });

  it("flags a script loaded from instafeed.nfcube.com as an Instagram Feed GHOST_SCRIPT", () => {
    const findings = detectGhostScripts(
      section(
        '<script src="https://instafeed.nfcube.com/cdn/feed.js?shop=x.myshopify.com"></script>',
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].appName).toBe(APP);
  });

  it("attributes Instafeed's documented instafeed-shopify container class", () => {
    expect(identifyAppFromCode('<div id="feed-43017" class="instafeed-shopify"></div>')).toBe(APP);
  });
});
