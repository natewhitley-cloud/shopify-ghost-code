/**
 * Unescaped menu-label signal wiring in scanThemeFiles (gc-7gjj.2 Phase 0).
 *
 * Dark, ops telemetry only: the detector runs on the scannable Liquid files
 * (blocks/ included), only while MENU_LABEL_SIGNAL_ENABLED === "true", and
 * only adds a `menuLabels` summary to the ScanResult. It never adds findings.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as menuLabel from "../../app/lib/unescaped-menu-label";
import {
  MAX_SCANNABLE_FILE_BYTES,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";
import { isMenuLabelSignalEnabled } from "../../app/services/soft-launch-flags.server";

vi.mock("../../app/lib/unescaped-menu-label", { spy: true });

const FLAG = "MENU_LABEL_SIGNAL_ENABLED";
const FIXTURES = join(__dirname, "..", "fixtures", "menu-labels");
const fixture = (theme: string, path: string): ThemeFile => ({
  filename: path,
  content: readFileSync(join(FIXTURES, theme, path), "utf8"),
});

const HORIZON: ThemeFile[] = [
  fixture("horizon", "blocks/_header-menu.liquid"),
  fixture("horizon", "blocks/menu.liquid"),
  fixture("horizon", "snippets/mega-menu-list.liquid"),
  fixture("horizon", "snippets/header-drawer.liquid"),
  // Not scannable Liquid: never read by this signal.
  {
    filename: "assets/menu.js",
    content: "{% for link in menu.links %}{{ link.title }}{% endfor %}",
  },
];
const DAWN: ThemeFile[] = [
  fixture("dawn", "snippets/header-dropdown-menu.liquid"),
  fixture("dawn", "snippets/header-mega-menu.liquid"),
  fixture("dawn", "snippets/header-drawer.liquid"),
  fixture("dawn", "sections/footer.liquid"),
];

describe("isMenuLabelSignalEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    ["true", true],
  ])("reads %s as %s (only exactly 'true' is on)", (value, expected) => {
    vi.stubEnv(FLAG, value as string);
    expect(isMenuLabelSignalEnabled()).toBe(expected);
  });
});

describe("scanThemeFiles unescaped menu-label signal", () => {
  beforeEach(() => {
    vi.mocked(menuLabel.detectUnescapedMenuLabels).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does no work and adds no key while the flag is off", () => {
    vi.stubEnv(FLAG, "false");
    const result = scanThemeFiles(HORIZON);
    expect("menuLabels" in result).toBe(false);
    expect(menuLabel.detectUnescapedMenuLabels).not.toHaveBeenCalled();
  });

  it("Horizon: 7 prints in 3 files, scannable Liquid only", () => {
    vi.stubEnv(FLAG, "true");
    const result = scanThemeFiles(HORIZON);
    expect(result.menuLabels).toEqual({
      fileCount: 3,
      outputCount: 7,
      files: [
        { path: "blocks/_header-menu.liquid", lines: [57, 114] },
        { path: "blocks/menu.liquid", lines: [50, 52, 76] },
        { path: "snippets/mega-menu-list.liquid", lines: [135, 156] },
      ],
    });
    expect(menuLabel.detectUnescapedMenuLabels).toHaveBeenCalledTimes(4);
  });

  it("counts two prints on one line as two outputs and skips a raw block (audit fix)", () => {
    vi.stubEnv(FLAG, "true");
    const content =
      "{% for link in menu.links %}\n{{ link.title }} {{ link.title }}\n" +
      "{% raw %}{{ link.title }}{% endraw %}\n{% endfor %}";
    const result = scanThemeFiles([{ filename: "snippets/nav.liquid", content }]);
    expect(result.menuLabels).toEqual({
      fileCount: 1,
      outputCount: 2,
      files: [{ path: "snippets/nav.liquid", lines: [2] }],
    });
  });

  it("Dawn: an empty summary with the flag on", () => {
    vi.stubEnv(FLAG, "true");
    expect(scanThemeFiles(DAWN).menuLabels).toEqual({ fileCount: 0, outputCount: 0, files: [] });
  });

  it("never changes the findings (telemetry only)", () => {
    vi.stubEnv(FLAG, "false");
    const off = scanThemeFiles(HORIZON);
    vi.stubEnv(FLAG, "true");
    const on = scanThemeFiles(HORIZON);
    expect(on.findings).toEqual(off.findings);
    expect(on.skippedFiles).toEqual(off.skippedFiles);
  });

  it("skips an oversized Liquid file like every per-file detector", () => {
    vi.stubEnv(FLAG, "true");
    const body = "{% for link in menu.links %}{{ link.title }}{% endfor %}\n";
    const content = body.repeat(Math.ceil((MAX_SCANNABLE_FILE_BYTES + 1) / body.length));
    const result = scanThemeFiles([{ filename: "snippets/huge.liquid", content }]);
    expect(result.menuLabels).toEqual({ fileCount: 0, outputCount: 0, files: [] });
    expect(result.skippedFiles?.map((f) => f.filename)).toEqual(["snippets/huge.liquid"]);
  });
});
