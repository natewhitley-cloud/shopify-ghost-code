/**
 * gc-gxnp: app embed fingerprints.
 *
 * gc-gxnp: APP_EMBED_OFF / GHOST_APP_EMBED store the embed's settings_data.json
 * entry as `JSON.stringify({ [key]: value }, null, 2)` at line 1, whose first
 * line is always "{". The fingerprint hashed only that line, so every embed
 * finding of a type shared one identity. Old stored rows must keep matching new
 * ones (no one-time New/Fixed churn), and an instance ignore made before the
 * fix (keyed on the "{" fingerprint) must keep hiding what it hid.
 */
import { FindingType } from "@prisma/client";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/models/finding.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/models/finding.server")>();
  return { ...actual, getFindingsForScan: vi.fn(), getFindingSummary: vi.fn() };
});

import type { ShopIgnores } from "../../app/models/ignored-finding.server";
import { isFindingIgnored } from "../../app/services/finding-aggregation.server";
import {
  diffScans,
  djb2Hex,
  fingerprintFinding,
  type DiffableFinding,
} from "../../app/services/scan-differ.server";

const SETTINGS = "config/settings_data.json";

/** The detectors' stored snippet for one embed entry (parseAppEmbedEntries). */
function embedSnippet(key: string, handle: string, block: string, disabled = true): string {
  const value = {
    type: `shopify://apps/${handle}/blocks/${block}/0b6f1c2e-1111-2222-3333-444455556666`,
    disabled,
    settings: { color: "#000000" },
  };
  return JSON.stringify({ [key]: value }, null, 2).slice(0, 300);
}

function finding(
  findingType: string,
  codeSnippet: string,
  over: Partial<DiffableFinding> = {},
): DiffableFinding {
  return {
    filename: SETTINGS,
    findingType,
    codeSnippet,
    lineNumber: 1,
    severity: "MEDIUM",
    appName: null,
    description: "d",
    ...over,
  };
}

/** The pre-fix fingerprint: djb2 over filename, type and the first line "{". */
const legacyFp = (type: string) => djb2Hex(`${SETTINGS}\0${type}\0{`);

const noIgnores = (): ShopIgnores => ({ fingerprints: new Set(), appNames: new Set() });

describe("gc-gxnp: app embed findings have distinct fingerprints", () => {
  const klaviyo = embedSnippet("111", "klaviyo-email-marketing", "klaviyo-onsite-embed");
  const judgeme = embedSnippet("222", "judgeme", "judgeme_core");

  it.each([FindingType.APP_EMBED_OFF, FindingType.GHOST_APP_EMBED])(
    "%s: two embeds of the same type get different fingerprints",
    (type) => {
      expect(fingerprintFinding(SETTINGS, type, klaviyo, 1)).not.toBe(
        fingerprintFinding(SETTINGS, type, judgeme, 1),
      );
    },
  );

  it("the same embed keeps its fingerprint across scans (key, uuid and settings may change)", () => {
    const later = JSON.stringify(
      {
        "999": {
          type: "shopify://apps/klaviyo-email-marketing/blocks/klaviyo-onsite-embed/ffffffff-0000-0000-0000-000000000000",
          disabled: true,
          settings: { color: "#ffffff" },
        },
      },
      null,
      2,
    );
    expect(fingerprintFinding(SETTINGS, FindingType.APP_EMBED_OFF, later, 1)).toBe(
      fingerprintFinding(SETTINGS, FindingType.APP_EMBED_OFF, klaviyo, 1),
    );
  });

  it("diff: one embed turned back on reads as 1 Fixed, the other unchanged", () => {
    const prev = [
      finding(FindingType.APP_EMBED_OFF, klaviyo, { appName: "Klaviyo" }),
      finding(FindingType.APP_EMBED_OFF, judgeme, { appName: "Judge.me" }),
    ];
    const cur = [finding(FindingType.APP_EMBED_OFF, judgeme, { appName: "Judge.me" })];
    const diff = diffScans(cur, prev);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.newFindings).toEqual([]);
    expect(diff.resolvedFindings.map((f) => f.appName)).toEqual(["Klaviyo"]);
  });

  it("an instance ignore of one embed no longer hides the other", () => {
    const ignores = noIgnores();
    ignores.fingerprints.add(fingerprintFinding(SETTINGS, FindingType.APP_EMBED_OFF, klaviyo, 1));
    expect(isFindingIgnored(finding(FindingType.APP_EMBED_OFF, klaviyo), ignores)).toBe(true);
    expect(isFindingIgnored(finding(FindingType.APP_EMBED_OFF, judgeme), ignores)).toBe(false);
  });

  it("a legacy ignore (pre-fix '{' fingerprint) still hides what it hid: no resurfacing", () => {
    const ignores = noIgnores();
    ignores.fingerprints.add(legacyFp(FindingType.APP_EMBED_OFF));
    expect(isFindingIgnored(finding(FindingType.APP_EMBED_OFF, klaviyo), ignores)).toBe(true);
    expect(isFindingIgnored(finding(FindingType.APP_EMBED_OFF, judgeme), ignores)).toBe(true);
    // Scoped to the embed types: another type whose first line is "{" is not hidden.
    expect(
      isFindingIgnored(
        finding(FindingType.APP_EMBED_OFF, klaviyo, { filename: "x.json" }),
        ignores,
      ),
    ).toBe(false);
  });

  it("other finding types keep the first-line fingerprint unchanged (stored ignores intact)", () => {
    const snippet = '<script src="https://cdn.example.com/a.js"></script>';
    expect(fingerprintFinding("layout/theme.liquid", "GHOST_SCRIPT", snippet, 1)).toBe(
      djb2Hex(`layout/theme.liquid\0GHOST_SCRIPT\0${snippet}`),
    );
  });

  it("an embed snippet with no recognisable block type falls back to the old identity", () => {
    expect(fingerprintFinding(SETTINGS, FindingType.APP_EMBED_OFF, "{\n  ", 1)).toBe(
      legacyFp(FindingType.APP_EMBED_OFF),
    );
  });
});
