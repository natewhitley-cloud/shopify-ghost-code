/**
 * Tests for app/services/app-removal.server.ts (gc-frda): pure removal
 * detection, signature fingerprints and REMOVED-record state transitions.
 */
import { AppRemovalState, FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import type { AppSignature } from "../../app/data/app-signatures.server";
import type { ShopIgnores } from "../../app/models/ignored-finding.server";
import {
  computeAppSignatureFingerprints,
  detectAppRemovals,
  nextRemovalState,
  parseAppSignatureFingerprints,
  planAppRemovals,
  type RemovalFinding,
  type RemovalScan,
} from "../../app/services/app-removal.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_TYPES = Object.values(FindingType) as string[];
const FP = { Klaviyo: "k1", "Reviews App": "r1", Privy: "p1" };
const NO_IGNORES: ShopIgnores = { fingerprints: new Set(), appNames: new Set() };

let seq = 0;
function finding(appName: string | null, over: Partial<RemovalFinding> = {}): RemovalFinding {
  seq += 1;
  return {
    filename: `snippets/f${seq}.liquid`,
    findingType: FindingType.GHOST_SCRIPT,
    codeSnippet: `<script src="https://x/${seq}.js"></script>`,
    lineNumber: 1,
    appName,
    ...over,
  };
}

function many(n: number, appName: string, over: Partial<RemovalFinding> = {}) {
  return Array.from({ length: n }, () => finding(appName, over));
}

function scan(findings: RemovalFinding[], over: Partial<RemovalScan> = {}): RemovalScan {
  return {
    findings,
    skippedCategories: [],
    cappedCategories: [],
    unreachableCategories: [],
    skippedFiles: [],
    liveFindingTypes: ALL_TYPES,
    appSignatureFingerprints: FP,
    ...over,
  };
}

const detect = (cur: RemovalScan, prev: RemovalScan, ignores: ShopIgnores = NO_IGNORES) =>
  detectAppRemovals(cur, prev, { ignores });

// ---------------------------------------------------------------------------
// detectAppRemovals
// ---------------------------------------------------------------------------

describe("detectAppRemovals", () => {
  it("0 -> N findings for an app is a removal with leftoverCount N", () => {
    expect(detect(scan(many(3, "Klaviyo")), scan([]))).toEqual([
      { appName: "Klaviyo", leftoverCount: 3 },
    ]);
  });

  it("N -> M findings is not a removal", () => {
    expect(detect(scan(many(5, "Klaviyo")), scan(many(2, "Klaviyo")))).toEqual([]);
  });

  it("empty current scan: no removals", () => {
    expect(detect(scan([]), scan(many(2, "Klaviyo")))).toEqual([]);
  });

  it("type unaudited in P (scope granted since: the read_products case) is not a removal", () => {
    const metafields = many(172, "Reviews App", { findingType: FindingType.GHOST_METAFIELD });
    const prev = scan([], { skippedCategories: [FindingType.GHOST_METAFIELD] });
    expect(detect(scan(metafields), prev)).toEqual([]);
  });

  it("type capped or unreachable in either scan is excluded from both sides", () => {
    const metafields = many(4, "Reviews App", { findingType: FindingType.GHOST_METAFIELD });
    expect(
      detect(scan(metafields), scan([], { cappedCategories: [FindingType.GHOST_METAFIELD] })),
    ).toEqual([]);
    expect(
      detect(scan(metafields, { unreachableCategories: [FindingType.GHOST_METAFIELD] }), scan([])),
    ).toEqual([]);
  });

  it("type not live in P is not a removal", () => {
    const embed = many(2, "Klaviyo", { findingType: FindingType.GHOST_APP_EMBED });
    const prev = scan([], {
      liveFindingTypes: ALL_TYPES.filter((t) => t !== FindingType.GHOST_APP_EMBED),
    });
    expect(detect(scan(embed), prev)).toEqual([]);
  });

  it("a mix: only the audited-in-both findings count toward leftoverCount", () => {
    const cur = [
      ...many(2, "Reviews App"),
      ...many(9, "Reviews App", { findingType: FindingType.GHOST_METAFIELD }),
    ];
    const prev = scan([], { skippedCategories: [FindingType.GHOST_METAFIELD] });
    expect(detect(scan(cur), prev)).toEqual([{ appName: "Reviews App", leftoverCount: 2 }]);
  });

  it("legacy scan with no recorded live set (either side): no removals", () => {
    expect(detect(scan(many(2, "Klaviyo")), scan([], { liveFindingTypes: null }))).toEqual([]);
    expect(detect(scan(many(2, "Klaviyo"), { liveFindingTypes: undefined }), scan([]))).toEqual([]);
  });

  it("per-file findings in a file size-skipped in P are not a removal", () => {
    const f = finding("Klaviyo", { filename: "layout/theme.liquid" });
    expect(detect(scan([f]), scan([], { skippedFiles: ["layout/theme.liquid"] }))).toEqual([]);
  });

  it("a cross-file type in a size-skipped file still counts (it was computed)", () => {
    const f = finding("Klaviyo", {
      filename: "assets/klaviyo.js",
      findingType: FindingType.ORPHAN_ASSET,
    });
    expect(detect(scan([f]), scan([], { skippedFiles: ["assets/klaviyo.js"] }))).toEqual([
      { appName: "Klaviyo", leftoverCount: 1 },
    ]);
  });

  it("signature fingerprint differs between P and S: not a removal", () => {
    const prev = scan([], { appSignatureFingerprints: { ...FP, Klaviyo: "k0" } });
    expect(detect(scan(many(2, "Klaviyo")), prev)).toEqual([]);
  });

  it("P fingerprints NULL (legacy scan): no removals at all", () => {
    const cur = scan([...many(2, "Klaviyo"), ...many(1, "Privy")]);
    expect(detect(cur, scan([], { appSignatureFingerprints: null }))).toEqual([]);
    expect(detect(cur, scan([], { appSignatureFingerprints: undefined }))).toEqual([]);
  });

  it("malformed fingerprints JSON is treated as never recorded", () => {
    const cur = scan(many(2, "Klaviyo"));
    expect(detect(cur, scan([], { appSignatureFingerprints: ["k1"] }))).toEqual([]);
    expect(detect(cur, scan([], { appSignatureFingerprints: { Klaviyo: 1 } }))).toEqual([]);
  });

  it("app missing from the fingerprints (either side): not a removal", () => {
    const withoutKlaviyo: Record<string, string> = { ...FP };
    delete withoutKlaviyo.Klaviyo;
    expect(
      detect(scan(many(2, "Klaviyo")), scan([], { appSignatureFingerprints: withoutKlaviyo })),
    ).toEqual([]);
    expect(
      detect(scan(many(2, "Klaviyo"), { appSignatureFingerprints: withoutKlaviyo }), scan([])),
    ).toEqual([]);
    // An app attributed outside APP_SIGNATURES is never eligible.
    expect(detect(scan(many(2, "Unknown Vendor")), scan([]))).toEqual([]);
  });

  it("APP-scope ignored app is not a removal", () => {
    const ignores = { fingerprints: new Set<string>(), appNames: new Set(["Klaviyo"]) };
    expect(detect(scan(many(3, "Klaviyo")), scan([]), ignores)).toEqual([]);
  });

  it("instance-ignored findings reduce the count, and can zero it", () => {
    const fs = many(3, "Klaviyo");
    const fpOf = (f: RemovalFinding) =>
      fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);
    const one = { fingerprints: new Set([fpOf(fs[0])]), appNames: new Set<string>() };
    expect(detect(scan(fs), scan([]), one)).toEqual([{ appName: "Klaviyo", leftoverCount: 2 }]);
    const all = { fingerprints: new Set(fs.map(fpOf)), appNames: new Set<string>() };
    expect(detect(scan(fs), scan([]), all)).toEqual([]);
  });

  it("an ignored finding in P does not stop a removal of the app's other code", () => {
    const old = finding("Klaviyo");
    const ignores = {
      fingerprints: new Set([
        fingerprintFinding(old.filename, old.findingType, old.codeSnippet, old.lineNumber),
      ]),
      appNames: new Set<string>(),
    };
    expect(detect(scan([old, ...many(2, "Klaviyo")]), scan([old]), ignores)).toEqual([
      { appName: "Klaviyo", leftoverCount: 2 },
    ]);
  });

  it("multiple apps at once, sorted by name; apps already present are skipped", () => {
    const cur = scan([...many(1, "Reviews App"), ...many(2, "Klaviyo"), ...many(4, "Privy")]);
    const prev = scan(many(1, "Privy"));
    expect(detect(cur, prev)).toEqual([
      { appName: "Klaviyo", leftoverCount: 2 },
      { appName: "Reviews App", leftoverCount: 1 },
    ]);
  });

  it("findings with a null appName never count", () => {
    expect(detect(scan([finding(null), finding(null)]), scan([]))).toEqual([]);
  });

  it("SCRIPT_TAG_SUNSET (a LIVE app's script tags) never counts toward a removal", () => {
    const tags = many(2, "Klaviyo", { findingType: FindingType.SCRIPT_TAG_SUNSET });
    expect(detect(scan(tags), scan([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

describe("computeAppSignatureFingerprints", () => {
  const base = (): AppSignature => ({
    appName: "Acme",
    cdnDomains: ["cdn.acme.com"],
    scriptPatterns: [/acme\.js/],
    snippetNames: ["acme-widget"],
    cssPatterns: [/acme/i],
  });

  it("is stable: same input -> same hash, an 8-char hex per app", () => {
    const a = computeAppSignatureFingerprints([base()]);
    expect(a).toEqual(computeAppSignatureFingerprints([base()]));
    expect(a.Acme).toMatch(/^[0-9a-f]{8}$/);
  });

  it("does not depend on object key order", () => {
    const sig = base();
    const reordered = Object.fromEntries(Object.entries(sig).reverse()) as AppSignature;
    expect(computeAppSignatureFingerprints([reordered])).toEqual(
      computeAppSignatureFingerprints([sig]),
    );
  });

  it("changes when a regex source changes", () => {
    const changed = { ...base(), scriptPatterns: [/acme-v2\.js/] };
    expect(computeAppSignatureFingerprints([changed]).Acme).not.toBe(
      computeAppSignatureFingerprints([base()]).Acme,
    );
  });

  it("changes when only a regex flag changes", () => {
    const changed = { ...base(), cssPatterns: [/acme/] };
    expect(computeAppSignatureFingerprints([changed]).Acme).not.toBe(
      computeAppSignatureFingerprints([base()]).Acme,
    );
  });

  it("changes when a domain is added", () => {
    const changed = { ...base(), cdnDomains: ["cdn.acme.com", "static.acme.com"] };
    expect(computeAppSignatureFingerprints([changed]).Acme).not.toBe(
      computeAppSignatureFingerprints([base()]).Acme,
    );
  });

  it("changes when an optional field is added; an undefined field is ignored", () => {
    const withEmbed = { ...base(), embedHandles: ["acme-embed"] };
    expect(computeAppSignatureFingerprints([withEmbed]).Acme).not.toBe(
      computeAppSignatureFingerprints([base()]).Acme,
    );
    expect(computeAppSignatureFingerprints([{ ...base(), embedHandles: undefined }])).toEqual(
      computeAppSignatureFingerprints([base()]),
    );
  });

  it("an edit to one app leaves every other app's fingerprint unchanged", () => {
    const other: AppSignature = { ...base(), appName: "Other", cdnDomains: ["o.com"] };
    const before = computeAppSignatureFingerprints([base(), other]);
    const after = computeAppSignatureFingerprints([{ ...base(), snippetNames: ["x"] }, other]);
    expect(after.Other).toBe(before.Other);
    expect(after.Acme).not.toBe(before.Acme);
  });

  it("covers every app in the real APP_SIGNATURES and round-trips through the parser", () => {
    const real = computeAppSignatureFingerprints();
    expect(Object.keys(real).length).toBeGreaterThan(50);
    expect(real.Klaviyo).toMatch(/^[0-9a-f]{8}$/);
    const parsed = parseAppSignatureFingerprints(JSON.parse(JSON.stringify(real)));
    expect(parsed?.get("Klaviyo")).toBe(real.Klaviyo);
  });
});

// ---------------------------------------------------------------------------
// nextRemovalState
// ---------------------------------------------------------------------------

describe("nextRemovalState", () => {
  const record = { id: "r1", appName: "Klaviyo", leftoverCount: 3 };
  const prev = () => scan(many(3, "Klaviyo"));
  const next = (
    cur: RemovalScan,
    opts: Partial<{ ignores: ShopIgnores; enabledEmbedApps: Set<string> | null }> = {},
    previous: RemovalScan | null = prev(),
  ) =>
    nextRemovalState(record, cur, previous, {
      ignores: opts.ignores ?? NO_IGNORES,
      enabledEmbedApps: opts.enabledEmbedApps === undefined ? new Set() : opts.enabledEmbedApps,
    });

  it("REMOVED -> CLEANED when the app has no findings left", () => {
    expect(next(scan([]))).toEqual({
      id: "r1",
      leftoverCount: 0,
      state: AppRemovalState.CLEANED,
    });
  });

  it("REMOVED -> REINSTALLED when no findings are left and its embed is enabled", () => {
    expect(next(scan([]), { enabledEmbedApps: new Set(["Klaviyo"]) })).toEqual({
      id: "r1",
      leftoverCount: 0,
      state: AppRemovalState.REINSTALLED,
    });
  });

  it("embed enabled but leftovers still found: stays REMOVED, count updated", () => {
    expect(next(scan(many(1, "Klaviyo")), { enabledEmbedApps: new Set(["Klaviyo"]) })).toEqual({
      id: "r1",
      leftoverCount: 1,
    });
  });

  it("updates leftoverCount when it changed; null when unchanged", () => {
    expect(next(scan(many(5, "Klaviyo")))).toEqual({ id: "r1", leftoverCount: 5 });
    expect(next(scan(many(3, "Klaviyo")))).toBeNull();
  });

  it("X's category not audited in S (scope revoked): no change", () => {
    const previous = scan(many(3, "Klaviyo", { findingType: FindingType.GHOST_METAFIELD }));
    const cur = scan([], { skippedCategories: [FindingType.GHOST_METAFIELD] });
    expect(next(cur, {}, previous)).toBeNull();
  });

  it("X's leftover file size-skipped in S: no change", () => {
    const previous = scan([finding("Klaviyo", { filename: "layout/theme.liquid" })]);
    expect(next(scan([], { skippedFiles: ["layout/theme.liquid"] }), {}, previous)).toBeNull();
  });

  it("previous scan had no visible findings for X (unknown then): no change", () => {
    expect(next(scan([]), {}, scan([]))).toBeNull();
  });

  it("no previous scan: no change", () => {
    expect(next(scan([]), {}, null)).toBeNull();
  });

  it("embed set unknown for this run: a 0-count record is left unchanged", () => {
    expect(next(scan([]), { enabledEmbedApps: null })).toBeNull();
  });

  it("APP-ignored app is left unchanged (hiding is not cleaning)", () => {
    const ignores = { fingerprints: new Set<string>(), appNames: new Set(["Klaviyo"]) };
    expect(next(scan([]), { ignores })).toBeNull();
  });

  it("instance ignores reduce the leftover count", () => {
    const fs = many(2, "Klaviyo");
    const ignores = {
      fingerprints: new Set([
        fingerprintFinding(fs[0].filename, fs[0].findingType, fs[0].codeSnippet, fs[0].lineNumber),
      ]),
      appNames: new Set<string>(),
    };
    expect(next(scan(fs), { ignores })).toEqual({ id: "r1", leftoverCount: 1 });
  });

  it("SCRIPT_TAG_SUNSET findings do not keep a record open", () => {
    const tags = many(2, "Klaviyo", { findingType: FindingType.SCRIPT_TAG_SUNSET });
    expect(next(scan(tags))).toMatchObject({ state: AppRemovalState.CLEANED });
  });
});

// ---------------------------------------------------------------------------
// planAppRemovals
// ---------------------------------------------------------------------------

describe("planAppRemovals", () => {
  it("combines new detections with updates to earlier open records", () => {
    const previous = scan(many(2, "Privy"));
    const current = scan(many(4, "Klaviyo"));
    const plan = planAppRemovals({
      currentScanId: "s2",
      current,
      previous,
      openRemovals: [{ id: "r1", appName: "Privy", leftoverCount: 2, detectedScanId: "s1" }],
      ignores: NO_IGNORES,
      enabledEmbedApps: new Set(),
    });
    expect(plan).toEqual({
      creates: [{ appName: "Klaviyo", leftoverCount: 4 }],
      updates: [{ id: "r1", leftoverCount: 0, state: AppRemovalState.CLEANED }],
    });
  });

  it("never re-evaluates a record detected on the current scan (retry safety)", () => {
    const plan = planAppRemovals({
      currentScanId: "s2",
      current: scan([]),
      previous: scan(many(2, "Privy")),
      openRemovals: [{ id: "r1", appName: "Privy", leftoverCount: 2, detectedScanId: "s2" }],
      ignores: NO_IGNORES,
      enabledEmbedApps: new Set(),
    });
    expect(plan.updates).toEqual([]);
  });

  it("empty input: empty plan", () => {
    expect(
      planAppRemovals({
        currentScanId: "s2",
        current: scan([]),
        previous: scan([]),
        openRemovals: [],
        ignores: NO_IGNORES,
        enabledEmbedApps: null,
      }),
    ).toEqual({ creates: [], updates: [] });
  });
});
