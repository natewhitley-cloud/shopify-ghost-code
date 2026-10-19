/**
 * Affected-app advisory, embed signal: each app's advisory has its OWN
 * fingerprint (audit HIGH, gc-5nok).
 *
 * An advisory has no appName, so its fingerprint is its only ignore key, and
 * the fingerprint hashes only the stored snippet's first line
 * (normalizeForFingerprint). The embed snippet used to start with the JSON
 * entry's "{", so every embed advisory hashed alike: ignoring Swym hid
 * Selleasy too, and the differ treated them as one finding. The detector now
 * leads the snippet with the listed block type (no uuid).
 *
 * The scan page half of "ignoring one leaves the other visible" is in
 * tests/routes/app.scans.$scanId.test.ts (affected-app advisory section).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/models/finding.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/models/finding.server")>()),
  getFindingsForScan: vi.fn(),
  getFindingSummary: vi.fn(),
}));

import { getFindingsForScan } from "../../app/models/finding.server";
import { getFilteredFindingSummaryAndKept } from "../../app/services/finding-aggregation.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";
import { detectAppIncidentAdvisories } from "../../app/services/scan-engine.server";
import { loadHomeSecurityRisks } from "../../app/services/security-risk.server";

const SETTINGS = "config/settings_data.json";
const ACTIVE = new Date("2026-10-20T12:00:00Z");
const ADVISORY_FLAG = "APP_INCIDENT_ADVISORY_LIVE_ENABLED";

const SWYM_HANDLE = "shopify://apps/wishlist-plus/blocks/wishlist-app-embed";
const SELLEASY_HANDLE = "shopify://apps/selleasy/blocks/app-embed";
const HULK_HANDLE = "shopify://apps/hulk-product-options/blocks/app-embed";

/** A settings_data.json with these embed types enabled, under these block keys. */
const settingsFile = (blocks: Record<string, string>) => ({
  filename: SETTINGS,
  content:
    "/*\n * IMPORTANT: The contents of this file are auto-generated.\n */\n" +
    JSON.stringify(
      {
        current: {
          blocks: Object.fromEntries(
            Object.entries(blocks).map(([key, type]) => [
              key,
              { type, disabled: false, settings: {} },
            ]),
          ),
        },
      },
      null,
      2,
    ),
});

const fp = (f: {
  filename: string;
  findingType: string;
  codeSnippet: string;
  lineNumber: number;
}) => fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);

/** Swym + Selleasy (and Hulk) embeds, enabled, with the given uuids and block keys. */
const threeEmbeds = (uuid: string, keySuffix = "") =>
  detectAppIncidentAdvisories(
    [
      settingsFile({
        [`swym${keySuffix}`]: `${SWYM_HANDLE}/${uuid}`,
        [`selleasy${keySuffix}`]: `${SELLEASY_HANDLE}/${uuid}`,
        [`hulk${keySuffix}`]: `${HULK_HANDLE}/${uuid}`,
      }),
    ],
    ACTIVE,
  );

describe("embed advisory fingerprints", () => {
  it("(a) Swym, Selleasy and Hulk embeds in one settings_data.json get three different fingerprints", () => {
    const findings = threeEmbeds("80c3b1fc-3a8f-407e-8367-ffdeebb8b612");

    expect(findings.map((f) => f.description.split(" app embed")[0])).toEqual([
      "Has the Hulk Product Options",
      "Has the Swym Wishlist Plus",
      "Has the Selleasy",
    ]);
    expect(new Set(findings.map(fp)).size).toBe(3);
  });

  it("(c) stable across scans: a new uuid or block key for the same app gives the same fingerprint", () => {
    const first = threeEmbeds("80c3b1fc-3a8f-407e-8367-ffdeebb8b612");
    const later = threeEmbeds("11111111-2222-3333-4444-555555555555", "-renamed");

    expect(later.map(fp)).toEqual(first.map(fp));
    // Non-vacuous: the stored snippets themselves did change.
    expect(later.map((f) => f.codeSnippet)).not.toEqual(first.map((f) => f.codeSnippet));
  });

  it("the snippet leads with the listed block type and still holds the settings entry", () => {
    const uuid = "790c1a03-a71f-4bc1-9869-00dad526d3c2";
    const [, , selleasy] = threeEmbeds(uuid);

    const [first, ...rest] = selleasy.codeSnippet.split("\n");
    expect(first).toBe(SELLEASY_HANDLE);
    expect(first).not.toContain(uuid);
    expect(rest.join("\n")).toContain(`"type": "${SELLEASY_HANDLE}/${uuid}"`);
    expect(selleasy.codeSnippet.length).toBeLessThanOrEqual(300);
  });

  describe("(b) Home: ignoring one advisory leaves the other's banner and count", () => {
    beforeEach(() => {
      process.env[ADVISORY_FLAG] = "true";
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(ACTIVE);
    });
    afterEach(() => {
      vi.useRealTimers();
      delete process.env[ADVISORY_FLAG];
    });

    it("ignore Swym: Selleasy still has its banner and is still counted", async () => {
      const detected = detectAppIncidentAdvisories(
        [
          settingsFile({
            swym: `${SWYM_HANDLE}/80c3b1fc-3a8f-407e-8367-ffdeebb8b612`,
            selleasy: `${SELLEASY_HANDLE}/790c1a03-a71f-4bc1-9869-00dad526d3c2`,
          }),
        ],
        ACTIVE,
      );
      const rows = detected.map((f, i) => ({
        ...f,
        id: `adv-${i}`,
        scanId: "scan-1",
        appName: null,
        createdAt: ACTIVE,
      }));
      const [swym] = rows;
      (getFindingsForScan as ReturnType<typeof vi.fn>).mockResolvedValue(rows);

      const { summary, keptFindings } = await getFilteredFindingSummaryAndKept("scan-1", {
        fingerprints: new Set([fp(swym)]),
        appNames: new Set(),
      });
      const risks = await loadHomeSecurityRisks({
        shopId: "shop-1",
        scanId: "scan-1",
        keptByType: summary.byType,
        keptFindings,
        maliciousFound: 0,
        now: ACTIVE,
      });

      expect(summary.byType.APP_INCIDENT_ADVISORY).toBe(1);
      expect(risks).toEqual([expect.objectContaining({ kind: "advisory", appName: "Selleasy" })]);
    });
  });
});
