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
  detectAppEmbedOff,
  detectGhostAppEmbeds,
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

  it("keeps the active app's code in files it does not own", () => {
    const themeLayout: ThemeFile = {
      filename: "layout/theme.liquid",
      content: '<script src="https://cdn.ecomposer.app/vendors/js/ec-splide.min.js"></script>',
    };
    const settings = settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: false } });
    const kept = ecomFindings([themeLayout, settings]);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((f) => f.filename === "layout/theme.liquid")).toBe(true);
  });

  it("keeps another app's code inside the active builder's files", () => {
    const withJudgeMe: ThemeFile = {
      filename: "sections/ecom-reviews.liquid",
      content: '<script src="https://cdn.judge.me/widget_preloader.js"></script>',
    };
    const settings = settingsWith({ "1": { type: ECOMPOSER_TYPE, disabled: false } });
    const findings = scanThemeFiles([withJudgeMe, settings]).findings;
    expect(findings.some((f) => f.appName === "Judge.me")).toBe(true);
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
