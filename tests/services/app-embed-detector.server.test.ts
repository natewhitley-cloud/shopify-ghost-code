/**
 * APP_EMBED_OFF / GHOST_APP_EMBED detectors (gc-fed).
 *
 * Base fixture: the real Debut settings_data.json (header included, no app
 * blocks); app-block variants inject `current.blocks` entries into it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FindingType, Severity } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_APP_OWN_FILE_TYPES,
  detectAppEmbedOff,
  detectGhostAppEmbeds,
  dropActiveAppOwnFileFindings,
  enabledAppEmbedApps,
  ORPHAN_GRADE_CORROBORATION_TYPES,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";
import { SOFT_LAUNCH_FLAGS } from "../../app/services/soft-launch-flags.server";

const fixture = readFileSync(resolve(__dirname, "../fixtures/settings-data-debut.json"), "utf8");
const HEADER = fixture.slice(0, fixture.indexOf("*/") + 2);
const PAGEFLY_TYPE = "shopify://apps/pagefly-page-builder/blocks/app-embed/0f1e2d3c-aaaa-bbbb";

type Block = Record<string, unknown>;

function settingsWith(blocks: Record<string, Block> | undefined): ThemeFile {
  const data = JSON.parse(fixture.slice(HEADER.length));
  if (blocks === undefined) delete data.current.blocks;
  else data.current.blocks = blocks;
  return {
    filename: "config/settings_data.json",
    content: `${HEADER}\n${JSON.stringify(data, null, 2)}`,
  };
}

const pageflyLayout: ThemeFile = {
  filename: "layout/theme.pagefly.liquid",
  content: "<html>PageFly layout content</html>",
};
const klaviyoLayoutFinding = {
  filename: "snippets/x.liquid",
  lineNumber: 1,
  codeSnippet: "",
  findingType: FindingType.GHOST_SCRIPT,
  severity: Severity.HIGH,
  appName: "Klaviyo",
  description: "x",
};

afterEach(() => vi.useRealTimers());

describe("detectAppEmbedOff", () => {
  it("emits one finding per disabled app embed entry", () => {
    const file = settingsWith({
      "1": { type: PAGEFLY_TYPE, disabled: true, settings: {} },
      "2": { type: "shopify://apps/some-other-app/blocks/x/uuid", disabled: true },
      "3": { type: "shopify://apps/enabled-app/blocks/x/uuid", disabled: false },
    });
    const findings = detectAppEmbedOff([file]);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.findingType === FindingType.APP_EMBED_OFF)).toBe(true);
    expect(findings.every((f) => f.filename === "config/settings_data.json")).toBe(true);
    expect(findings.every((f) => f.lineNumber === 1)).toBe(true);
  });

  it("emits nothing for an enabled embed alone", () => {
    const file = settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } });
    expect(detectAppEmbedOff([file])).toEqual([]);
  });

  it("treats a missing disabled field as enabled", () => {
    expect(detectAppEmbedOff([settingsWith({ "1": { type: PAGEFLY_TYPE } })])).toEqual([]);
  });

  it("ignores non-app blocks", () => {
    const file = settingsWith({
      "1": { type: "shopify://theme/blocks/announcement/uuid", disabled: true },
      "2": { type: "announcement-bar", disabled: true },
    });
    expect(detectAppEmbedOff([file])).toEqual([]);
  });

  it("ignores malformed types and entries", () => {
    const file = settingsWith({
      "1": { type: "shopify://apps/", disabled: true },
      "2": { type: "shopify://apps//blocks/x", disabled: true },
      "3": { type: 42, disabled: true },
      "4": { disabled: true },
      "5": null as unknown as Block,
      "6": "str" as unknown as Block,
    });
    expect(detectAppEmbedOff([file])).toEqual([]);
  });

  it("emits nothing when blocks is missing or the wrong shape", () => {
    expect(detectAppEmbedOff([settingsWith(undefined)])).toEqual([]);
    expect(
      detectAppEmbedOff([
        { filename: "config/settings_data.json", content: '{"current":{"blocks":[1]}}' },
      ]),
    ).toEqual([]);
    expect(
      detectAppEmbedOff([{ filename: "config/settings_data.json", content: "not json" }]),
    ).toEqual([]);
    expect(detectAppEmbedOff([])).toEqual([]);
  });

  it("uses the signature app name for a known handle", () => {
    const [f] = detectAppEmbedOff([settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: true } })]);
    expect(f.appName).toBe("PageFly");
    expect(f.description).toBe("PageFly's theme app embed is turned off.");
  });

  it("humanizes an unknown handle", () => {
    const [f] = detectAppEmbedOff([
      settingsWith({
        "1": { type: "shopify://apps/acme-super_widget/blocks/x/u", disabled: true },
      }),
    ]);
    expect(f.appName).toBe("Acme Super Widget");
    expect(f.description).toBe("Acme Super Widget's theme app embed is turned off.");
  });

  it("truncates the code snippet to 300 chars and keeps the entry JSON", () => {
    const [f] = detectAppEmbedOff([
      settingsWith({
        "1": { type: PAGEFLY_TYPE, disabled: true, settings: { a: "x".repeat(500) } },
      }),
    ]);
    expect(f.codeSnippet).toHaveLength(300);
    expect(f.codeSnippet).toContain(PAGEFLY_TYPE);
  });

  describe("severity date switch (2027-03-01T00:00:00Z)", () => {
    const file = settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: true } });

    it("is MEDIUM one millisecond before the cutoff", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2027-02-28T23:59:59.999Z"));
      expect(detectAppEmbedOff([file])[0].severity).toBe(Severity.MEDIUM);
    });

    it("is HIGH at the cutoff and after", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2027-03-01T00:00:00.000Z"));
      expect(detectAppEmbedOff([file])[0].severity).toBe(Severity.HIGH);
      vi.setSystemTime(new Date("2028-01-01T00:00:00.000Z"));
      expect(detectAppEmbedOff([file])[0].severity).toBe(Severity.HIGH);
    });

    it("is MEDIUM well before the cutoff (today)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
      expect(detectAppEmbedOff([file])[0].severity).toBe(Severity.MEDIUM);
    });
  });
});

describe("GHOST_APP_EMBED via scanThemeFiles", () => {
  const ofType = (files: ThemeFile[], t: FindingType) =>
    scanThemeFiles(files).findings.filter((f) => f.findingType === t);

  it("does NOT flag an actively used app: enabled embed + theme.pagefly.liquid only (gc-n02p)", () => {
    // A template is needed for layout detection to trust its usage check (gc-vi7b);
    // this one does not reference the layout, so the layout is still an orphan.
    const indexTemplate = { filename: "templates/index.json", content: "{}" };
    const files = [
      settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } }),
      pageflyLayout,
      indexTemplate,
    ];
    const result = scanThemeFiles(files).findings;
    // The layout file IS detected as PageFly code...
    expect(
      result.some((f) => f.findingType === FindingType.GHOST_LAYOUT && f.appName === "PageFly"),
    ).toBe(true);
    // ...but "this code belongs to PageFly" is not evidence PageFly is gone.
    expect(result.filter((f) => f.findingType === FindingType.GHOST_APP_EMBED)).toEqual([]);
  });

  it("does not flag when corroboration is a soft-launched type (SETTINGS_DRIFT)", () => {
    const direct = detectGhostAppEmbeds(
      [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } })],
      [{ ...klaviyoLayoutFinding, findingType: FindingType.SETTINGS_DRIFT, appName: "PageFly" }],
    );
    expect(direct).toEqual([]);
  });

  it("flags when corroborated by a type in the (injected) allowlist", () => {
    const direct = detectGhostAppEmbeds(
      [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } })],
      [{ ...klaviyoLayoutFinding, findingType: FindingType.ORPHAN_ASSET, appName: "PageFly" }],
      new Set([FindingType.ORPHAN_ASSET]),
    );
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({
      findingType: FindingType.GHOST_APP_EMBED,
      appName: "PageFly",
      severity: Severity.LOW,
      filename: "config/settings_data.json",
      lineNumber: 1,
      description:
        "PageFly's app embed is still switched on, and PageFly left other code in this theme.",
    });
  });

  it("the production allowlist is empty and excludes every soft-launched type", () => {
    expect(ORPHAN_GRADE_CORROBORATION_TYPES.size).toBe(0);
    for (const type of Object.keys(SOFT_LAUNCH_FLAGS)) {
      expect(ORPHAN_GRADE_CORROBORATION_TYPES.has(type as FindingType)).toBe(false);
    }
    for (const type of [FindingType.APP_EMBED_OFF, FindingType.GHOST_APP_EMBED]) {
      expect(ORPHAN_GRADE_CORROBORATION_TYPES.has(type)).toBe(false);
    }
  });

  it("does not flag an enabled embed alone", () => {
    const files = [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } })];
    expect(ofType(files, FindingType.GHOST_APP_EMBED)).toEqual([]);
  });

  it("does not flag an enabled embed when only a different app has findings", () => {
    const direct = detectGhostAppEmbeds(
      [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } })],
      [klaviyoLayoutFinding],
    );
    expect(direct).toEqual([]);
  });

  it("does not flag an unknown-handle embed even with findings present", () => {
    const files = [
      settingsWith({ "1": { type: "shopify://apps/unknown-app/blocks/x/u", disabled: false } }),
      pageflyLayout,
    ];
    expect(ofType(files, FindingType.GHOST_APP_EMBED)).toEqual([]);
  });

  it("a disabled embed with corroboration yields only APP_EMBED_OFF", () => {
    const files = [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: true } }), pageflyLayout];
    expect(ofType(files, FindingType.APP_EMBED_OFF)).toHaveLength(1);
    expect(ofType(files, FindingType.GHOST_APP_EMBED)).toEqual([]);
  });

  it("another app's embed findings do not corroborate", () => {
    const direct = detectGhostAppEmbeds(
      [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } })],
      [{ ...klaviyoLayoutFinding, findingType: FindingType.APP_EMBED_OFF, appName: "PageFly" }],
    );
    expect(direct).toEqual([]);
  });

  it("scanThemeFiles surfaces APP_EMBED_OFF for a disabled embed", () => {
    const files = [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: true } })];
    expect(ofType(files, FindingType.APP_EMBED_OFF)).toHaveLength(1);
  });
});

// gc-clt4: an ENABLED app embed means the app is live, so findings for that
// app inside the theme files it OWNS (its filePatterns) are its working code,
// not leftovers. Real case: paw-naturals ran EComposer (embed handle
// `ecomposer-builder`, read off the live storefront) and got 212 findings in
// its sections/ecom-*.liquid files.
describe("active app embed suppresses the app's own-file findings (gc-clt4)", () => {
  const ECOMPOSER_TYPE = "shopify://apps/ecomposer-builder/blocks/app-embed/1a2b3c4d";
  const ecomSection: ThemeFile = {
    filename: "sections/ecom-welcome-page.liquid",
    content: [
      '<link rel="stylesheet" href="https://cdn.ecomposer.app/vendors/css/ecom-base.css">',
      '<script src="https://cdn.ecomposer.app/vendors/js/ec-splide.min.js" defer></script>',
    ].join("\n"),
  };
  const ecomFindings = (files: ThemeFile[]) =>
    scanThemeFiles(files).findings.filter((f) => f.appName === "EComposer");

  it("maps the real EComposer embed handle to the signature", () => {
    const off = detectAppEmbedOff([
      settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: true } }),
    ]);
    expect(off[0].appName).toBe("EComposer");
  });

  it("baseline: without an embed entry the section is flagged", () => {
    expect(ecomFindings([ecomSection, settingsWith(undefined)]).length).toBeGreaterThan(0);
  });

  it("drops EComposer findings in its own section files when its embed is enabled", () => {
    const settings = settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: false } });
    expect(ecomFindings([ecomSection, settings])).toEqual([]);
  });

  it("treats a missing disabled field as enabled", () => {
    expect(ecomFindings([ecomSection, settingsWith({ "1": { type: ECOMPOSER_TYPE } })])).toEqual(
      [],
    );
  });

  it("keeps the findings when the embed is disabled", () => {
    const settings = settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: true } });
    const findings = scanThemeFiles([ecomSection, settings]).findings;
    expect(
      findings.some((f) => f.appName === "EComposer" && f.filename === ecomSection.filename),
    ).toBe(true);
  });

  // gc-ps3t (1A) replaced the gc-clt4 "own files only" rule: a live app's
  // code is live wherever it sits in the theme.
  it("drops the active app's code in files it does not own (gc-ps3t 1A)", () => {
    const themeLayout: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.ecomposer.app/vendors/js/ec-splide.min.js"></script>',
    };
    expect(ecomFindings([themeLayout, settingsWith(undefined)]).length).toBeGreaterThan(0);
    const settings = settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: false } });
    expect(ecomFindings([themeLayout, settings])).toEqual([]);
  });

  // gc-ps3t (2A) replaced the gc-clt4 rule: another app's code inside a live
  // builder's file is the builder's built-in option, not a leftover.
  it("drops another app's code inside the active builder's files (gc-ps3t 2A)", () => {
    const withJudgeMe: ThemeFile = {
      filename: "sections/ecom-reviews.liquid",
      content: '<script src="https://cdn.judge.me/widget_preloader.js"></script>',
    };
    const judgeMe = (s: ThemeFile) =>
      scanThemeFiles([withJudgeMe, s]).findings.filter((f) => f.appName === "Judge.me");
    expect(judgeMe(settingsWith(undefined)).length).toBeGreaterThan(0);
    expect(judgeMe(settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: false } }))).toEqual([]);
  });

  it("never drops a malicious-script alert, even in an active app's file", () => {
    const injected: ThemeFile = {
      filename: "sections/ecom-hijacked.liquid",
      content: '<script src="https://jsdeliver.cloud/shopify.js"></script>',
    };
    const settings = settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: false } });
    const findings = scanThemeFiles([injected, settings]).findings;
    expect(findings.some((f) => f.findingType === FindingType.MALICIOUS_SCRIPT)).toBe(true);
  });

  it("only the app whose embed is enabled is affected", () => {
    const settings = settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } });
    expect(ecomFindings([ecomSection, settings]).length).toBeGreaterThan(0);
  });

  it("works for any signature with embedHandles + filePatterns (PageFly)", () => {
    const pfSection: ThemeFile = {
      filename: "sections/pagefly-landing.liquid",
      content: '<script src="https://cdn.pagefly.io/runtime.js"></script>',
    };
    const pfFindings = (s: ThemeFile) =>
      scanThemeFiles([pfSection, s]).findings.filter((f) => f.appName === "PageFly");
    expect(pfFindings(settingsWith(undefined)).length).toBeGreaterThan(0);
    expect(pfFindings(settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } }))).toEqual([]);
  });
});

// gc-ps3t: paw-naturals (paying store) still got two false-positive classes
// after gc-clt4. (1) Klaviyo is live, but its script inside an EComposer-owned
// section was flagged because the file was not Klaviyo's. (2) EComposer is
// live and its generated sections carry a review-provider switch
// (`{%- when 'judgeme' -%} <div class='jdgm-widget ...'>`), flagged as a
// Judge.me leftover though Judge.me was never installed. Decisions (Nathan,
// 2026-10-04): 1A drop a live app's findings anywhere in the theme; 2A drop
// every in-set finding inside a file a live app owns.
describe("live apps' findings are suppressed theme-wide and inside live builders' files (gc-ps3t)", () => {
  const ECOMPOSER_TYPE = "shopify://apps/ecomposer-builder/blocks/app-embed/1a2b3c4d";
  const KLAVIYO_TYPE =
    "shopify://apps/klaviyo-email-marketing-sms/blocks/klaviyo-onsite-embed/0b1c2d3e";
  const live = (...types: string[]) =>
    settingsWith(Object.fromEntries(types.map((type, i) => [String(i + 1), { type }])));

  const klaviyoInEcom: ThemeFile = {
    filename: "sections/ecom-sign-up-page.liquid",
    content:
      '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=AbC123"></script>',
  };
  // The switch keys on a local variable, so the gc-0bow theme-setting gate
  // (which needs `settings.` in the opener) does not catch it, as in prod.
  const judgeMeSwitch = [
    "{%- case ecom_review_app -%}",
    "  {%- when 'judgeme' -%}",
    "    <div class='jdgm-widget jdgm-preview-badge' data-id='{{ product.id }}'></div>",
    "{%- endcase -%}",
  ].join("\n");
  const judgeMeInEcom: ThemeFile = {
    filename: "sections/ecom-blog-post-page-article.liquid",
    content: judgeMeSwitch,
  };
  const judgeMeInMainProduct: ThemeFile = {
    filename: "sections/main-product.liquid",
    content: judgeMeSwitch,
  };
  const scan = (files: ThemeFile[]) => scanThemeFiles(files).findings;
  const forApp = (files: ThemeFile[], app: string) => scan(files).filter((f) => f.appName === app);

  it("maps the real Klaviyo embed handle to the signature", () => {
    const off = detectAppEmbedOff([settingsWith({ "1": { type: KLAVIYO_TYPE, disabled: true } })]);
    expect(off[0].appName).toBe("Klaviyo");
  });

  it("baseline: Klaviyo's script in an EComposer file is flagged with no embeds", () => {
    const found = forApp([klaviyoInEcom, settingsWith(undefined)], "Klaviyo");
    expect(found.some((f) => f.findingType === FindingType.GHOST_SCRIPT)).toBe(true);
  });

  it("1A: live Klaviyo's GHOST_SCRIPT in an EComposer-owned file is dropped (Klaviyo live only)", () => {
    expect(forApp([klaviyoInEcom, live(KLAVIYO_TYPE)], "Klaviyo")).toEqual([]);
  });

  it("1A: live Klaviyo's GHOST_SCRIPT in layout/theme.liquid is dropped", () => {
    const themeLayout: ThemeFile = {
      filename: "layout/theme.liquid",
      content: klaviyoInEcom.content,
    };
    expect(forApp([themeLayout, settingsWith(undefined)], "Klaviyo").length).toBeGreaterThan(0);
    expect(forApp([themeLayout, live(KLAVIYO_TYPE)], "Klaviyo")).toEqual([]);
  });

  it("baseline: Judge.me GHOST_TEXT in an EComposer file is flagged with no embeds", () => {
    const found = forApp([judgeMeInEcom, settingsWith(undefined)], "Judge.me");
    expect(found.some((f) => f.findingType === FindingType.GHOST_TEXT)).toBe(true);
  });

  it("2A: Judge.me GHOST_TEXT inside a live EComposer section is dropped (Judge.me not live)", () => {
    expect(forApp([judgeMeInEcom, live(ECOMPOSER_TYPE)], "Judge.me")).toEqual([]);
  });

  it("2A: the same Judge.me finding in a non-builder file is kept", () => {
    const found = forApp([judgeMeInMainProduct, live(ECOMPOSER_TYPE)], "Judge.me");
    expect(found.some((f) => f.findingType === FindingType.GHOST_TEXT)).toBe(true);
  });

  it("a disabled embed suppresses nothing", () => {
    const settings = settingsWith({
      "1": { type: KLAVIYO_TYPE, disabled: true },
      "2": { type: ECOMPOSER_TYPE, disabled: true },
    });
    expect(forApp([klaviyoInEcom, settings], "Klaviyo").length).toBeGreaterThan(0);
    expect(forApp([judgeMeInEcom, settings], "Judge.me").length).toBeGreaterThan(0);
  });

  it("an unknown embed handle suppresses nothing", () => {
    const settings = live("shopify://apps/some-unknown-app/blocks/app-embed/ffff");
    expect(forApp([klaviyoInEcom, settings], "Klaviyo").length).toBeGreaterThan(0);
    expect(forApp([judgeMeInEcom, settings], "Judge.me").length).toBeGreaterThan(0);
  });

  describe("type gate (direct)", () => {
    const finding = (findingType: FindingType, filename: string, appName: string | undefined) => ({
      filename,
      lineNumber: 1,
      codeSnippet: "",
      findingType,
      severity: Severity.HIGH,
      appName,
      description: "x",
    });
    const settings = live(KLAVIYO_TYPE, ECOMPOSER_TYPE);
    const EXCLUDED = [FindingType.GHOST_LAYOUT, FindingType.MALICIOUS_SCRIPT];

    it("the excluded types are not in ACTIVE_APP_OWN_FILE_TYPES", () => {
      for (const t of EXCLUDED) expect(ACTIVE_APP_OWN_FILE_TYPES.has(t)).toBe(false);
    });

    it.each(EXCLUDED)("keeps %s for a live app, in its own file and elsewhere", (t) => {
      const input = [
        finding(t, "sections/ecom-landing.liquid", "EComposer"),
        finding(t, "layout/theme.liquid", "EComposer"),
        finding(t, "layout/theme.liquid", "Klaviyo"),
        finding(t, "sections/ecom-sign-up-page.liquid", "Klaviyo"),
        finding(t, "sections/ecom-landing.liquid", undefined),
      ];
      expect(dropActiveAppOwnFileFindings([settings], input)).toEqual(input);
    });

    it("drops GHOST_OG for a live app, in its own file and elsewhere (2026-10-05)", () => {
      const input = [
        finding(FindingType.GHOST_OG, "snippets/ecom_theme_helper.liquid", "EComposer"),
        finding(FindingType.GHOST_OG, "layout/theme.liquid", "EComposer"),
        finding(FindingType.GHOST_OG, "layout/theme.liquid", "Klaviyo"),
        finding(FindingType.GHOST_OG, "sections/ecom-landing.liquid", undefined),
      ];
      expect(dropActiveAppOwnFileFindings([settings], input)).toEqual([]);
    });

    it("keeps GHOST_OG when neither its app nor its file's owner is live", () => {
      const input = [
        finding(FindingType.GHOST_OG, "layout/theme.liquid", undefined),
        finding(FindingType.GHOST_OG, "layout/theme.liquid", "Yotpo"),
      ];
      expect(dropActiveAppOwnFileFindings([settings], input)).toEqual(input);
    });

    it("filters GHOST_OG per finding: drops the live app's, keeps the dead app's", () => {
      const dead = finding(FindingType.GHOST_OG, "layout/theme.liquid", "Yotpo");
      const input = [
        finding(FindingType.GHOST_OG, "snippets/ecom_theme_helper.liquid", "EComposer"),
        dead,
      ];
      expect(dropActiveAppOwnFileFindings([settings], input)).toEqual([dead]);
    });

    it("keeps GHOST_OG when no app embed is enabled", () => {
      const input = [
        finding(FindingType.GHOST_OG, "snippets/ecom_theme_helper.liquid", "EComposer"),
      ];
      expect(dropActiveAppOwnFileFindings([], input)).toEqual(input);
    });

    it("drops an appName-less in-set finding inside a live builder's file", () => {
      const input = [finding(FindingType.ORPHAN_ASSET, "sections/ecom-landing.liquid", undefined)];
      expect(dropActiveAppOwnFileFindings([settings], input)).toEqual([]);
    });

    it("keeps an appName-less in-set finding in a file no live app owns", () => {
      const input = [finding(FindingType.ORPHAN_ASSET, "sections/main-product.liquid", undefined)];
      expect(dropActiveAppOwnFileFindings([settings], input)).toEqual(input);
    });

    it("keeps an in-set finding when neither its app nor its file's owner is live", () => {
      const input = [finding(FindingType.GHOST_SCRIPT, "sections/main-product.liquid", "Judge.me")];
      expect(dropActiveAppOwnFileFindings([settings], input)).toEqual(input);
    });
  });
});

describe("enabledAppEmbedApps", () => {
  const KLAVIYO_TYPE = "shopify://apps/klaviyo-email-marketing-sms/blocks/klaviyo-onsite-embed/abc";

  it("returns signature names of ENABLED embeds only", () => {
    const settings = settingsWith({
      "1": { type: PAGEFLY_TYPE, disabled: false },
      "2": { type: KLAVIYO_TYPE, disabled: true },
    });
    expect([...enabledAppEmbedApps([settings])]).toEqual(["PageFly"]);
  });

  it("recognizes the verified Judge.me and Ryviu embed handles", () => {
    const settings = settingsWith({
      "1": { type: "shopify://apps/judge-me-reviews/blocks/preview_badge/abc", disabled: false },
      "2": { type: "shopify://apps/ryviu-product-reviews/blocks/ryviu-embed/def" },
    });
    expect([...enabledAppEmbedApps([settings])].sort()).toEqual(["Judge.me", "Ryviu"]);
  });

  it("treats an entry with no disabled flag as enabled", () => {
    const settings = settingsWith({ "1": { type: KLAVIYO_TYPE } });
    expect([...enabledAppEmbedApps([settings])]).toEqual(["Klaviyo"]);
  });

  it("skips unmatched handles and non-app blocks, never guessing a name", () => {
    const settings = settingsWith({
      "1": { type: "shopify://apps/unknown-app/blocks/x/uuid", disabled: false },
      "2": { type: "header", disabled: false },
    });
    expect(enabledAppEmbedApps([settings]).size).toBe(0);
  });

  it("is empty without a settings_data.json or blocks", () => {
    expect(enabledAppEmbedApps([]).size).toBe(0);
    expect(enabledAppEmbedApps([settingsWith(undefined)]).size).toBe(0);
  });
});
