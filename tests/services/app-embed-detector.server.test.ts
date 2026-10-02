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
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";

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

  it("flags an enabled embed when the same app has another finding (GHOST_LAYOUT)", () => {
    const files = [settingsWith({ "1": { type: PAGEFLY_TYPE, disabled: false } }), pageflyLayout];
    const result = scanThemeFiles(files).findings;
    expect(
      result.some((f) => f.findingType === FindingType.GHOST_LAYOUT && f.appName === "PageFly"),
    ).toBe(true);
    const ghost = result.filter((f) => f.findingType === FindingType.GHOST_APP_EMBED);
    expect(ghost).toHaveLength(1);
    expect(ghost[0]).toMatchObject({
      appName: "PageFly",
      severity: Severity.LOW,
      filename: "config/settings_data.json",
      lineNumber: 1,
      description:
        "PageFly's app embed is still switched on, and PageFly left other code in this theme.",
    });
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
