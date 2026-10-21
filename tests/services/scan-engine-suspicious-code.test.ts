/**
 * Suspicious-code signal wiring in scanThemeFiles (gc-dcyh Phase 0).
 *
 * Dark, ops telemetry only: the detector runs on the asset JS the
 * MALICIOUS_SCRIPT pass already reads, only while
 * SUSPICIOUS_CODE_SIGNAL_ENABLED === "true", and only adds a
 * `suspiciousCode` summary to the ScanResult. It never adds findings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as suspicious from "../../app/lib/suspicious-code";
import {
  MAX_SCANNABLE_FILE_BYTES,
  scanThemeFiles,
  type ThemeFile,
} from "../../app/services/scan-engine.server";
import { isSuspiciousCodeSignalEnabled } from "../../app/services/soft-launch-flags.server";
import {
  DAWN_GLOBAL_STYLE,
  JQUERY_STYLE,
  OBFUSCATOR_SAMPLE,
  PACKER_SAMPLE,
} from "../fixtures/suspicious-code-samples";

vi.mock("../../app/lib/suspicious-code", { spy: true });

const FLAG = "SUSPICIOUS_CODE_SIGNAL_ENABLED";

const THEME: ThemeFile[] = [
  { filename: "layout/theme.liquid", content: "<html>{{ content_for_layout }}</html>" },
  // Packer-shaped Liquid is NOT checked: the signal is asset JS only.
  { filename: "snippets/packed.liquid", content: `<script>${PACKER_SAMPLE}</script>` },
  { filename: "assets/global.js", content: DAWN_GLOBAL_STYLE },
  { filename: "assets/vendor.js", content: JQUERY_STYLE },
  { filename: "assets/shrine.null.js", content: OBFUSCATOR_SAMPLE },
  { filename: "assets/theme.css", content: PACKER_SAMPLE },
  { filename: "assets/loader.js.liquid", content: PACKER_SAMPLE },
];

describe("isSuspiciousCodeSignalEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    ["true", true],
  ])("reads %s as %s (only exactly 'true' is on)", (value, expected) => {
    if (value === undefined) vi.stubEnv(FLAG, undefined as unknown as string);
    else vi.stubEnv(FLAG, value);
    expect(isSuspiciousCodeSignalEnabled()).toBe(expected);
  });
});

describe("scanThemeFiles suspicious-code signal", () => {
  beforeEach(() => {
    vi.mocked(suspicious.detectSuspiciousCode).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does no work and adds no key while the flag is off", () => {
    vi.stubEnv(FLAG, "false");
    const result = scanThemeFiles(THEME);
    expect("suspiciousCode" in result).toBe(false);
    expect(suspicious.detectSuspiciousCode).not.toHaveBeenCalled();
  });

  it("summarizes flagged asset JS only while the flag is on", () => {
    vi.stubEnv(FLAG, "true");
    const result = scanThemeFiles(THEME);
    expect(result.suspiciousCode).toEqual({
      fileCount: 2,
      files: [
        { path: "assets/loader.js.liquid", reasons: ["packer"] },
        {
          path: "assets/shrine.null.js",
          reasons: ["filename_marker", "obfuscator_identifiers"],
        },
      ],
      reasonCounts: { packer: 1, filename_marker: 1, obfuscator_identifiers: 1 },
    });
    // Only the four asset JS files were read (not Liquid, not CSS).
    expect(vi.mocked(suspicious.detectSuspiciousCode).mock.calls.map(([p]) => p)).toEqual([
      "assets/global.js",
      "assets/vendor.js",
      "assets/shrine.null.js",
      "assets/loader.js.liquid",
    ]);
  });

  it("reports an empty summary on a clean theme with the flag on", () => {
    vi.stubEnv(FLAG, "true");
    const result = scanThemeFiles(THEME.filter((f) => !/null|loader/.test(f.filename)));
    expect(result.suspiciousCode).toEqual({ fileCount: 0, files: [], reasonCounts: {} });
  });

  it("never changes the findings (telemetry only)", () => {
    vi.stubEnv(FLAG, "false");
    const off = scanThemeFiles(THEME);
    vi.stubEnv(FLAG, "true");
    const on = scanThemeFiles(THEME);
    expect(on.findings).toEqual(off.findings);
    expect(on.skippedFiles).toEqual(off.skippedFiles);
  });

  it("checks an asset over the 1 MB per-file cap (assets are never size-skipped)", () => {
    vi.stubEnv(FLAG, "true");
    const big = DAWN_GLOBAL_STYLE.repeat(
      Math.ceil((MAX_SCANNABLE_FILE_BYTES + 1) / DAWN_GLOBAL_STYLE.length),
    );
    const content = big + PACKER_SAMPLE;
    expect(content.length).toBeGreaterThan(MAX_SCANNABLE_FILE_BYTES);
    const result = scanThemeFiles([{ filename: "assets/huge.js", content }]);
    expect(result.suspiciousCode?.files).toEqual([{ path: "assets/huge.js", reasons: ["packer"] }]);
    expect(result.skippedFiles).toEqual([]);
  });
});
