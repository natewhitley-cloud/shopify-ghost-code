/**
 * Affected-app advisory, embed signal and the Swym Wishlist Plus / Selleasy
 * entries (gc-14x5.1, gc-14x5.2).
 *
 * An entry fires when the theme LOADS one of its script hosts (covered in
 * app-incident-advisory.server.test.ts) or, failing that, when the theme's
 * config/settings_data.json has one of its app embeds ENABLED. A disabled
 * embed loads nothing and never fires. The stored description says which
 * signal matched, and the card copy follows it.
 *
 * The worker gates (flag off, draft theme, expiry) for the embed signal are
 * covered in tests/inngest/scan-theme.test.ts.
 */
import { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
  matchAdvisoryEmbedType,
  type AppIncidentAdvisory,
} from "../../app/data/app-incident-advisories.server";
import {
  buildRemovalInstructions,
  findingMatchedLine,
  getFindingCardCopy,
  getFindingImpact,
  getFindingRemediation,
  isAdvisoryEmbedFinding,
} from "../../app/lib/finding-remediation";
import {
  advisoryReportUrlForFinding,
  dropAdvisoryUnknownScripts,
} from "../../app/services/app-incident-advisory.server";
import { detectAppIncidentAdvisories, scanThemeFiles } from "../../app/services/scan-engine.server";

const byName = (name: string): AppIncidentAdvisory => {
  const entry = APP_INCIDENT_ADVISORIES.find((a) => a.appName === name);
  if (!entry) throw new Error(`no entry ${name}`);
  return entry;
};
const HULK = byName("Hulk Product Options");
const SWYM = byName("Swym Wishlist Plus");
const SELLEASY = byName("Selleasy");

const SWYM_TYPE =
  "shopify://apps/wishlist-plus/blocks/wishlist-app-embed/80c3b1fc-3a8f-407e-8367-ffdeebb8b612";
const SELLEASY_TYPE =
  "shopify://apps/selleasy/blocks/app-embed/790c1a03-a71f-4bc1-9869-00dad526d3c2";
const SELLEASY_HOST = "upsell-app.logbase.io";
const SETTINGS = "config/settings_data.json";

/** A day on which every real entry is active. */
const ACTIVE = new Date("2026-10-20T12:00:00Z");

/** Shopify's auto-generated header, which the theme files API returns. */
const HEADER =
  "/*\n * IMPORTANT: The contents of this file are auto-generated.\n * This file may be updated by the Shopify admin theme editor.\n */\n";

type Block = { type: string; disabled?: unknown; settings?: Record<string, unknown> };
const settingsFile = (blocks: Record<string, Block>, header = HEADER) => ({
  filename: SETTINGS,
  content: header + JSON.stringify({ current: { blocks } }, null, 2),
});
const liquid = (filename: string, content: string) => ({ filename, content });
const detect = (files: Array<{ filename: string; content: string }>, now: Date = ACTIVE) =>
  detectAppIncidentAdvisories(files, now);

const SWYM_EMBED_DESCRIPTION =
  "Has the Swym Wishlist Plus app embed turned on, an app whose developer reported that an unauthorized change to its configuration made a script load on some storefronts that could send shoppers to a fake checkout page (14 October 2026)";
const SELLEASY_EMBED_DESCRIPTION =
  "Has the Selleasy app embed turned on, an app whose developer reported that an unauthorized script on some stores sent shoppers to a phishing page (13 October 2026)";
const SELLEASY_HOST_DESCRIPTION =
  "Loads code from Selleasy (upsell-app.logbase.io), an app whose developer reported that an unauthorized script on some stores sent shoppers to a phishing page (13 October 2026)";

// ---------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------

describe("the Swym Wishlist Plus and Selleasy entries", () => {
  it("Swym keys on its embed handle only (swymrelay.com is shared by every Swym app)", () => {
    expect(SWYM.scriptHosts).toEqual([]);
    expect(SWYM.embedHandles).toEqual(["shopify://apps/wishlist-plus/blocks/wishlist-app-embed"]);
  });

  it("Selleasy keys on the exact upsell-app host and its embed handle, never a Logbase base domain", () => {
    expect(SELLEASY.scriptHosts).toEqual([SELLEASY_HOST]);
    expect(SELLEASY.embedHandles).toEqual(["shopify://apps/selleasy/blocks/app-embed"]);
    const hosts = APP_INCIDENT_ADVISORIES.flatMap((a) => a.scriptHosts);
    for (const broad of ["logbase.io", "cdn.logbase.io", "www.logbase.io", "swymrelay.com"]) {
      expect(hosts).not.toContain(broad);
    }
  });

  it("Hulk's embed handle is the Hulk Product Options app's (gc-q5z8, seen in 6 public themes)", () => {
    expect(HULK.embedHandles).toEqual(["shopify://apps/hulk-product-options/blocks/app-embed"]);
    // Other HulkApps apps have their own app handles and never match.
    for (const sibling of [
      "shopify://apps/hulk-form-builder/blocks/app-embed/b6b8dd14-356b-4725-a4ed-77232212b3c3",
      "shopify://apps/hulk-discounts/blocks/app-embed/25745434-52e7-4378-88f1-890df18a0110",
      "shopify://apps/hulk-product-reviews/blocks/app/1",
      "shopify://apps/hulk-advanced-wishlist/blocks/app/1",
    ]) {
      expect(matchAdvisoryEmbedType(sibling), sibling).toBeNull();
    }
    expect(
      matchAdvisoryEmbedType(
        "shopify://apps/hulk-product-options/blocks/app-embed/380168ef-9475-4244-a291-f66b189208b5",
      )?.advisory.appName,
    ).toBe("Hulk Product Options");
  });

  it.each(APP_INCIDENT_ADVISORIES)(
    "$appName: embed handles are lower-case shopify://apps/<app>/blocks/<block> prefixes, no uuid",
    (entry) => {
      for (const handle of entry.embedHandles) {
        expect(handle).toMatch(/^shopify:\/\/apps\/[a-z0-9-]+\/blocks\/[a-z0-9_-]+$/);
      }
      expect(new Set(entry.embedHandles).size).toBe(entry.embedHandles.length);
    },
  );

  it("no two entries share an embed handle", () => {
    const handles = APP_INCIDENT_ADVISORIES.flatMap((a) => a.embedHandles);
    expect(new Set(handles).size).toBe(handles.length);
  });
});

// ---------------------------------------------------------------------------
// matchAdvisoryEmbedType
// ---------------------------------------------------------------------------

describe("matchAdvisoryEmbedType", () => {
  it.each([
    [SWYM_TYPE, SWYM],
    [SELLEASY_TYPE, SELLEASY],
    // Another install of the same block has another uuid: still a match.
    ["shopify://apps/selleasy/blocks/app-embed/00000000-0000-0000-0000-000000000000", SELLEASY],
    // The handle alone (no uuid segment).
    ["shopify://apps/selleasy/blocks/app-embed", SELLEASY],
    // Case-insensitive.
    [SWYM_TYPE.toUpperCase(), SWYM],
  ])("%s matches", (type, entry) => {
    expect(matchAdvisoryEmbedType(type)?.advisory).toBe(entry);
  });

  it.each([
    // Sibling blocks and apps of the same vendors.
    "shopify://apps/wishlist-plus/blocks/other-embed/80c3b1fc-3a8f-407e-8367-ffdeebb8b612",
    "shopify://apps/swym-back-in-stock/blocks/wishlist-app-embed/80c3b1fc",
    "shopify://apps/wishlist-plus-pro/blocks/wishlist-app-embed/80c3b1fc",
    "shopify://apps/selleasy/blocks/app-embed-v2/790c1a03",
    "shopify://apps/selleasy/blocks/app-embed/790c1a03/extra",
    "shopify://apps/selleasy/blocks/app-embed/",
    "shopify://apps/selleasy-upsell/blocks/app-embed/790c1a03",
    "shopify://apps/selleasy/blocks/upsell-widget/790c1a03",
    // Lookalikes and partials.
    "shopify://apps/selleasy",
    "xshopify://apps/selleasy/blocks/app-embed/790c1a03",
    "",
  ])("%s does not match", (type) => {
    expect(matchAdvisoryEmbedType(type)).toBeNull();
  });

  it("matches only the entries it is given", () => {
    expect(matchAdvisoryEmbedType(SWYM_TYPE, [])).toBeNull();
    expect(matchAdvisoryEmbedType(SWYM_TYPE, [SELLEASY, HULK])).toBeNull();
    expect(matchAdvisoryEmbedType(SWYM_TYPE, [SWYM])).toEqual({
      advisory: SWYM,
      embedHandle: "shopify://apps/wishlist-plus/blocks/wishlist-app-embed",
    });
  });
});

// ---------------------------------------------------------------------------
// Descriptions: the matched signal is in the wording
// ---------------------------------------------------------------------------

describe("advisoryDescription by signal", () => {
  it("embed signal: 'Has the <App> app embed turned on', then the report and its date", () => {
    expect(advisoryDescription({ advisory: SWYM, embedHandle: SWYM.embedHandles[0] })).toBe(
      SWYM_EMBED_DESCRIPTION,
    );
    expect(advisoryDescription({ advisory: SELLEASY, embedHandle: SELLEASY.embedHandles[0] })).toBe(
      SELLEASY_EMBED_DESCRIPTION,
    );
  });

  it("host signal: 'Loads code from <App> (<host>)', unchanged", () => {
    expect(advisoryDescription({ advisory: SELLEASY, scriptHost: SELLEASY_HOST })).toBe(
      SELLEASY_HOST_DESCRIPTION,
    );
  });

  it("no dashes, no trailing period, no claim about this store", () => {
    for (const text of [
      SWYM_EMBED_DESCRIPTION,
      SELLEASY_EMBED_DESCRIPTION,
      SELLEASY_HOST_DESCRIPTION,
    ]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/\.$/);
      expect(text).not.toMatch(/\byour\b/i);
      expect(text).not.toMatch(/hijack|compromised|infected|hacked/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The detector, embed signal
// ---------------------------------------------------------------------------

describe("detectAppIncidentAdvisories: embed signal", () => {
  describe.each([
    ["Swym Wishlist Plus", SWYM_TYPE, SWYM_EMBED_DESCRIPTION],
    ["Selleasy", SELLEASY_TYPE, SELLEASY_EMBED_DESCRIPTION],
  ])("%s", (_name, type, description) => {
    it("fires on an ENABLED embed: one HIGH finding on settings_data.json, line 1, no app name", () => {
      const findings = detect([
        settingsFile({ "1234567890": { type, disabled: false, settings: {} } }),
      ]);
      expect(findings).toEqual([
        {
          filename: SETTINGS,
          lineNumber: 1,
          codeSnippet: expect.stringContaining(type),
          findingType: FindingType.APP_INCIDENT_ADVISORY,
          severity: Severity.HIGH,
          appName: undefined,
          description,
        },
      ]);
    });

    it("fires when `disabled` is absent (Shopify omits it for an enabled embed)", () => {
      expect(detect([settingsFile({ a: { type } })])).toHaveLength(1);
    });

    it("does NOT fire on a DISABLED embed", () => {
      expect(detect([settingsFile({ a: { type, disabled: true } })])).toEqual([]);
    });

    it("does not fire after its review date, fires on the day itself", () => {
      const entry = APP_INCIDENT_ADVISORIES.find((a) => description.includes(a.appName))!;
      const files = [settingsFile({ a: { type } })];
      expect(detect(files, new Date(`${entry.reviewBy}T23:59:59.999Z`))).toHaveLength(1);
      const dayAfter = new Date(Date.parse(`${entry.reviewBy}T00:00:00Z`) + 86_400_000);
      expect(detect(files, dayAfter)).toEqual([]);
    });

    it("parses without the comment header too", () => {
      expect(detect([settingsFile({ a: { type } }, "")])).toHaveLength(1);
    });

    it("the same block type in a JSON template or a Liquid file is not an embed", () => {
      const json = JSON.stringify({ current: { blocks: { a: { type } } } });
      expect(
        detect([
          { filename: "templates/index.json", content: json },
          liquid("layout/theme.liquid", `<!-- ${type} -->\n{{ '${type}' }}`),
        ]),
      ).toEqual([]);
    });
  });

  it("a sibling app or block of the same vendor never fires", () => {
    expect(
      detect([
        settingsFile({
          a: { type: "shopify://apps/wishlist-plus/blocks/other-embed/80c3b1fc" },
          b: { type: "shopify://apps/swym-back-in-stock/blocks/wishlist-app-embed/80c3b1fc" },
          c: { type: "shopify://apps/selleasy/blocks/app-embed-v2/790c1a03" },
          d: { type: "shopify://apps/selleasy-upsell/blocks/app-embed/790c1a03" },
        }),
      ]),
    ).toEqual([]);
  });

  it("a disabled copy beside an enabled one still fires once", () => {
    expect(
      detect([settingsFile({ a: { type: SWYM_TYPE, disabled: true }, b: { type: SWYM_TYPE } })]),
    ).toHaveLength(1);
  });

  it("two entries by embed give two findings, in list order", () => {
    const findings = detect([settingsFile({ a: { type: SELLEASY_TYPE }, b: { type: SWYM_TYPE } })]);
    expect(findings.map((f) => f.description)).toEqual([
      SWYM_EMBED_DESCRIPTION,
      SELLEASY_EMBED_DESCRIPTION,
    ]);
  });

  it.each([
    ["malformed JSON", `${HEADER}{"current": {"blocks": {`],
    ["`current` is a preset name", JSON.stringify({ current: "Default", presets: {} })],
    ["no blocks map", JSON.stringify({ current: {} })],
    ["blocks is an array", JSON.stringify({ current: { blocks: [{ type: SWYM_TYPE }] } })],
    [
      "a block type that is not a string",
      JSON.stringify({ current: { blocks: { a: { type: 7 } } } }),
    ],
    ["an empty file", ""],
  ])("%s: nothing, no throw", (_label, content) => {
    expect(detect([{ filename: SETTINGS, content }])).toEqual([]);
  });

  it("an embed in presets (not `current`) is not on", () => {
    const content = JSON.stringify({
      current: { blocks: {} },
      presets: { Default: { blocks: { a: { type: SWYM_TYPE } } } },
    });
    expect(detect([{ filename: SETTINGS, content }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The detector, Selleasy host signal
// ---------------------------------------------------------------------------

describe("detectAppIncidentAdvisories: Selleasy host signal", () => {
  it("fires on a <script src> on the exact host, with the host wording", () => {
    const findings = detect([
      liquid(
        "layout/theme.liquid",
        `<head>\n<script src="https://${SELLEASY_HOST}/selleasy.js" async></script>\n</head>`,
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      filename: "layout/theme.liquid",
      lineNumber: 2,
      description: SELLEASY_HOST_DESCRIPTION,
    });
  });

  it("fires on a script_tag filter on the exact host", () => {
    const findings = detect([
      liquid("snippets/selleasy.liquid", `{{ 'https://${SELLEASY_HOST}/widget.js' | script_tag }}`),
    ]);
    expect(findings.map((f) => f.description)).toEqual([SELLEASY_HOST_DESCRIPTION]);
  });

  it.each([
    "logbase.io",
    "cdn.logbase.io",
    "evil-upsell-app.logbase.io",
    "upsell-app.logbase.io.evil.test",
  ])("a script on %s never fires", (host) => {
    expect(
      detect([
        liquid(
          "layout/theme.liquid",
          `<script src="https://${host}/selleasy.js"></script>\n{{ 'https://${host}/a.js' | script_tag }}`,
        ),
      ]),
    ).toEqual([]);
  });

  it("host and embed both present: ONE finding, the host one (anchored to the line that loads it)", () => {
    const findings = detect([
      liquid("layout/theme.liquid", `<script src="https://${SELLEASY_HOST}/s.js"></script>`),
      settingsFile({ a: { type: SELLEASY_TYPE } }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      filename: "layout/theme.liquid",
      description: SELLEASY_HOST_DESCRIPTION,
    });
  });

  it("a host only mentioned (a stylesheet), with a disabled embed: nothing", () => {
    expect(
      detect([
        liquid(
          "layout/theme.liquid",
          `<link rel="stylesheet" href="https://${SELLEASY_HOST}/s.css">`,
        ),
        settingsFile({ a: { type: SELLEASY_TYPE, disabled: true } }),
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end through the scan engine
// ---------------------------------------------------------------------------

describe("scanThemeFiles with an embed match", () => {
  it("keeps the embed advisory (an advisory is never an active app's own code)", () => {
    const result = scanThemeFiles(
      [
        liquid(
          "layout/theme.liquid",
          "<html><head></head><body>{{ content_for_layout }}</body></html>",
        ),
        settingsFile({ a: { type: SWYM_TYPE }, b: { type: SELLEASY_TYPE } }),
      ],
      ACTIVE,
    );
    const advisories = result.findings.filter(
      (f) => f.findingType === FindingType.APP_INCIDENT_ADVISORY,
    );
    expect(advisories.map((f) => f.description)).toEqual([
      SWYM_EMBED_DESCRIPTION,
      SELLEASY_EMBED_DESCRIPTION,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stored finding resolution (loader)
// ---------------------------------------------------------------------------

describe("stored embed findings", () => {
  const stored = (description: string) => ({
    findingType: "APP_INCIDENT_ADVISORY",
    description,
  });

  it("resolve to their entry's source link", () => {
    expect(advisoryReportUrlForFinding(stored(SWYM_EMBED_DESCRIPTION), ACTIVE)).toBe(
      SWYM.sourceUrl,
    );
    expect(advisoryReportUrlForFinding(stored(SELLEASY_EMBED_DESCRIPTION), ACTIVE)).toBe(
      SELLEASY.sourceUrl,
    );
    expect(advisoryReportUrlForFinding(stored(SELLEASY_HOST_DESCRIPTION), ACTIVE)).toBe(
      SELLEASY.sourceUrl,
    );
  });

  it("round trip: the finding the detector emits resolves", () => {
    const [finding] = detect([settingsFile({ a: { type: SWYM_TYPE } })]);
    expect(advisoryReportUrlForFinding(finding, ACTIVE)).toBe(SWYM.sourceUrl);
  });

  it("no link once the entry has expired", () => {
    expect(
      advisoryReportUrlForFinding(stored(SWYM_EMBED_DESCRIPTION), new Date("2027-01-13T00:00:00Z")),
    ).toBeNull();
  });

  it("an embed-matched Selleasy advisory drops its host's unrecognized-script rows only", () => {
    const rows = [
      { url: `https://${SELLEASY_HOST}/s.js` },
      { url: "https://cdn.logbase.io/other.js" },
      { url: "https://cdn.unknown.test/a.js" },
    ];
    expect(dropAdvisoryUnknownScripts(rows, [stored(SELLEASY_EMBED_DESCRIPTION)])).toEqual([
      rows[1],
      rows[2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Card copy by signal
// ---------------------------------------------------------------------------

describe("card copy follows the matched signal", () => {
  const ADVISORY = "APP_INCIDENT_ADVISORY";
  const embedFinding = {
    findingType: ADVISORY,
    filename: SETTINGS,
    lineNumber: 1,
    codeSnippet: JSON.stringify({ a: { type: SWYM_TYPE } }, null, 2),
    description: SWYM_EMBED_DESCRIPTION,
  };
  const hostFinding = {
    findingType: ADVISORY,
    filename: "layout/theme.liquid",
    lineNumber: 2,
    codeSnippet: `<script src="https://${SELLEASY_HOST}/s.js"></script>`,
    description: SELLEASY_HOST_DESCRIPTION,
  };

  it("isAdvisoryEmbedFinding: settings_data.json advisories only", () => {
    expect(isAdvisoryEmbedFinding(embedFinding)).toBe(true);
    expect(isAdvisoryEmbedFinding(hostFinding)).toBe(false);
    expect(isAdvisoryEmbedFinding({ findingType: "APP_EMBED_OFF", filename: SETTINGS })).toBe(
      false,
    );
  });

  it("impact: 'Your theme has this app's embed turned on' vs 'Your theme loads a script'", () => {
    expect(getFindingImpact(ADVISORY, SETTINGS)).toBe(
      "Your theme has this app's embed turned on. A public report describes this app delivering code that sent shoppers to a fake checkout page on at least one store. GhostCode reads theme files and cannot see code an app loads while a shopper is browsing, so we cannot tell you whether your store was affected.",
    );
    expect(getFindingImpact(ADVISORY, "layout/theme.liquid")).toMatch(
      /^Your theme loads a script from this app\. .* This script loads whether or not the app is still installed\.$/,
    );
    // No filename: the host copy, as before.
    expect(getFindingImpact(ADVISORY)).toBe(getFindingImpact(ADVISORY, "layout/theme.liquid"));
  });

  it("confidence and last step differ; everything else is the advisory card", () => {
    const host = getFindingCardCopy(ADVISORY, "layout/theme.liquid");
    const embed = getFindingCardCopy(ADVISORY, SETTINGS);
    expect(host.confidence).toBe("Matched a script address from a public incident report.");
    expect(embed.confidence).toBe("Matched this app's embed in your theme settings.");
    expect(embed.steps?.slice(0, 4)).toEqual(host.steps?.slice(0, 4));
    expect(embed.steps?.at(-1)).toBe(
      "If you no longer use the app, uninstall it, or turn off its embed in Online Store, Themes, Customize, App embeds. If you still use it, ask the developer whether this affects you.",
    );
    expect(host.steps?.at(-1)).toMatch(/remove its script line/);
    expect({ ...embed, confidence: null, steps: null }).toEqual({
      ...host,
      confidence: null,
      steps: null,
    });
  });

  it("the how-to string is the embed steps, numbered", () => {
    const howTo = getFindingRemediation(ADVISORY, SETTINGS);
    expect(howTo).toMatch(/^1\. Open your store/);
    expect(howTo).toMatch(/5\. If you no longer use the app, uninstall it, or turn off its embed/);
    expect(howTo).not.toMatch(/script line/);
  });

  it("copied instructions: embed how-to, the settings entry as 'Code found', no 'this line' claim", () => {
    expect(findingMatchedLine(embedFinding)).toBeNull();
    const text = buildRemovalInstructions(embedFinding, "App security advisory");
    expect(text).toContain(SWYM_EMBED_DESCRIPTION);
    expect(text).toContain(`File: ${SETTINGS}  (line 1)`);
    expect(text).toContain("Code found:");
    expect(text).not.toContain("The finding is this line:");
    expect(text).toContain("turn off its embed");
    const hostText = buildRemovalInstructions(hostFinding, "App security advisory");
    expect(hostText).toContain("remove its script line");
  });

  it("no em or en dashes in any advisory copy", () => {
    const all = [
      getFindingImpact(ADVISORY, SETTINGS),
      getFindingRemediation(ADVISORY, SETTINGS),
      getFindingCardCopy(ADVISORY, SETTINGS).confidence,
      ...(getFindingCardCopy(ADVISORY, SETTINGS).steps ?? []),
    ].join(" ");
    expect(all).not.toMatch(/[—–]/);
  });
});
