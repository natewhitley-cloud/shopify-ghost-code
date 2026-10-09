/**
 * Tests for app/services/app-removal.server.ts (gc-frda): pure Rule 1D removal
 * detection (live hook gone + leftovers), signature fingerprints and
 * REMOVED-record state transitions.
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
  parseLiveAppHooks,
  planAppRemovals,
  scriptTagHookApps,
  type LiveAppHooks,
  type RemovalFinding,
  type RemovalScan,
} from "../../app/services/app-removal.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";
import {
  MAX_SCRIPT_TAG_GROUPS,
  MAX_SCRIPT_TAG_URLS,
} from "../../app/services/script-tag-sunset-detector.server";

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

/** Hooks: embed set observed (default none on), ScriptTag check dark. */
function hooks(over: Partial<LiveAppHooks> = {}): LiveAppHooks {
  return { embedApps: [], scriptTagApps: null, ...over };
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
    liveAppHooks: hooks(),
    ...over,
  };
}

/** P with X's embed on (its own-file findings were hidden by the scanner). */
const embedOn = (
  apps: string[],
  findings: RemovalFinding[] = [],
  over: Partial<RemovalScan> = {},
) => scan(findings, { liveAppHooks: hooks({ embedApps: apps }), ...over });

const detect = (cur: RemovalScan, prev: RemovalScan, ignores: ShopIgnores = NO_IGNORES) =>
  detectAppRemovals(cur, prev, { ignores });

// ---------------------------------------------------------------------------
// detectAppRemovals: Rule 1D triggers
// ---------------------------------------------------------------------------

describe("detectAppRemovals: live hook gone + leftovers (Rule 1D)", () => {
  it("installing a non-embed app (0 -> N findings, no hook either side) is NOT a removal", () => {
    // Regression for the Rule 1A flaw: a LIVE app without a recognised hook
    // has its code flagged, so its install reads as 0 -> N findings.
    expect(detect(scan(many(3, "Klaviyo")), scan([]))).toEqual([]);
  });

  it("embed on in P, off in S, findings in S -> removal with leftoverCount", () => {
    expect(detect(scan(many(3, "Klaviyo")), embedOn(["Klaviyo"]))).toEqual([
      { appName: "Klaviyo", leftoverCount: 3 },
    ]);
  });

  it("prior findings are irrelevant: N -> M with the embed gone is still a removal", () => {
    expect(detect(scan(many(5, "Klaviyo")), embedOn(["Klaviyo"], many(2, "Klaviyo")))).toEqual([
      { appName: "Klaviyo", leftoverCount: 5 },
    ]);
  });

  it("embed on in P, off in S, 0 findings -> NOT a removal (nothing left behind)", () => {
    expect(detect(scan([]), embedOn(["Klaviyo"]))).toEqual([]);
  });

  it("embed stays on -> no removal", () => {
    expect(detect(embedOn(["Klaviyo"], many(2, "Klaviyo")), embedOn(["Klaviyo"]))).toEqual([]);
  });

  it("embed set not recorded on P (or S) -> no removal", () => {
    const prev = scan([], { liveAppHooks: hooks({ embedApps: null }) });
    expect(detect(scan(many(2, "Klaviyo")), prev)).toEqual([]);
    expect(
      detect(
        scan(many(2, "Klaviyo"), { liveAppHooks: hooks({ embedApps: null }) }),
        embedOn(["Klaviyo"]),
      ),
    ).toEqual([]);
  });

  it("legacy P with no recorded hooks (NULL column or malformed) -> no removals", () => {
    const cur = scan(many(2, "Klaviyo"));
    expect(detect(cur, embedOn(["Klaviyo"], [], { liveAppHooks: null }))).toEqual([]);
    expect(detect(cur, embedOn(["Klaviyo"], [], { liveAppHooks: undefined }))).toEqual([]);
    expect(detect(cur, embedOn(["Klaviyo"], [], { liveAppHooks: ["Klaviyo"] }))).toEqual([]);
  });

  it("ScriptTag in P, absent in S, check ran in both -> removal", () => {
    const prev = scan([], { liveAppHooks: hooks({ scriptTagApps: ["Privy"] }) });
    const cur = scan(many(2, "Privy"), { liveAppHooks: hooks({ scriptTagApps: [] }) });
    expect(detect(cur, prev)).toEqual([{ appName: "Privy", leftoverCount: 2 }]);
  });

  it("ScriptTag signal ignored when the check was dark or unreachable in either scan", () => {
    const tagged = hooks({ scriptTagApps: ["Privy"] });
    const notObserved = hooks({ scriptTagApps: null });
    // Not observed in S: cannot END the hook.
    expect(
      detect(
        scan(many(2, "Privy"), { liveAppHooks: notObserved }),
        scan([], { liveAppHooks: tagged }),
      ),
    ).toEqual([]);
    // Not observed in P: cannot CREATE the hook.
    expect(
      detect(
        scan(many(2, "Privy"), { liveAppHooks: hooks({ scriptTagApps: [] }) }),
        scan([], { liveAppHooks: notObserved }),
      ),
    ).toEqual([]);
  });

  it("still live through the other source in S -> no removal", () => {
    // Embed off in S, but the app still loads through a ScriptTag in S.
    const prev = scan([], { liveAppHooks: hooks({ embedApps: ["Klaviyo"] }) });
    const cur = scan(many(2, "Klaviyo"), {
      liveAppHooks: hooks({ embedApps: [], scriptTagApps: ["Klaviyo"] }),
    });
    expect(detect(cur, prev)).toEqual([]);
  });

  it("multiple apps at once, sorted by name; only hook-ended apps with leftovers", () => {
    const prev = embedOn(["Reviews App", "Klaviyo", "Privy"]);
    const cur = scan([...many(1, "Reviews App"), ...many(2, "Klaviyo"), ...many(4, "Unhooked")], {
      liveAppHooks: hooks({ embedApps: ["Privy"] }),
    });
    expect(detect(cur, prev)).toEqual([
      { appName: "Klaviyo", leftoverCount: 2 },
      { appName: "Reviews App", leftoverCount: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// detectAppRemovals: finding guards
// ---------------------------------------------------------------------------

describe("detectAppRemovals: finding guards", () => {
  const prev = (over: Partial<RemovalScan> = {}) => embedOn(["Klaviyo", "Reviews App"], [], over);

  it("type unaudited in P (scope granted since: the read_products case) does not count", () => {
    const metafields = many(172, "Reviews App", { findingType: FindingType.GHOST_METAFIELD });
    expect(
      detect(scan(metafields), prev({ skippedCategories: [FindingType.GHOST_METAFIELD] })),
    ).toEqual([]);
  });

  it("the read_products case without any hook change is never a removal", () => {
    const metafields = many(172, "Reviews App", { findingType: FindingType.GHOST_METAFIELD });
    expect(
      detect(scan(metafields), scan([], { skippedCategories: [FindingType.GHOST_METAFIELD] })),
    ).toEqual([]);
  });

  it("type capped or unreachable in either scan does not count", () => {
    const metafields = many(4, "Reviews App", { findingType: FindingType.GHOST_METAFIELD });
    expect(
      detect(scan(metafields), prev({ cappedCategories: [FindingType.GHOST_METAFIELD] })),
    ).toEqual([]);
    expect(
      detect(scan(metafields, { unreachableCategories: [FindingType.GHOST_METAFIELD] }), prev()),
    ).toEqual([]);
  });

  it("type not live in P does not count", () => {
    const embed = many(2, "Klaviyo", { findingType: FindingType.GHOST_APP_EMBED });
    expect(
      detect(
        scan(embed),
        prev({ liveFindingTypes: ALL_TYPES.filter((t) => t !== FindingType.GHOST_APP_EMBED) }),
      ),
    ).toEqual([]);
  });

  it("a mix: only the audited-in-both findings count toward leftoverCount", () => {
    const cur = [
      ...many(2, "Reviews App"),
      ...many(9, "Reviews App", { findingType: FindingType.GHOST_METAFIELD }),
    ];
    expect(detect(scan(cur), prev({ skippedCategories: [FindingType.GHOST_METAFIELD] }))).toEqual([
      { appName: "Reviews App", leftoverCount: 2 },
    ]);
  });

  it("legacy scan with no recorded live set (either side): no removals", () => {
    expect(detect(scan(many(2, "Klaviyo")), prev({ liveFindingTypes: null }))).toEqual([]);
    expect(detect(scan(many(2, "Klaviyo"), { liveFindingTypes: undefined }), prev())).toEqual([]);
  });

  it("per-file findings in a file size-skipped in P do not count", () => {
    const f = finding("Klaviyo", { filename: "layout/theme.liquid" });
    expect(detect(scan([f]), prev({ skippedFiles: ["layout/theme.liquid"] }))).toEqual([]);
  });

  it("a cross-file type in a size-skipped file still counts (it was computed)", () => {
    const f = finding("Klaviyo", {
      filename: "assets/klaviyo.js",
      findingType: FindingType.ORPHAN_ASSET,
    });
    expect(detect(scan([f]), prev({ skippedFiles: ["assets/klaviyo.js"] }))).toEqual([
      { appName: "Klaviyo", leftoverCount: 1 },
    ]);
  });

  it("signature fingerprint differs between P and S: not a removal", () => {
    expect(
      detect(
        scan(many(2, "Klaviyo")),
        prev({ appSignatureFingerprints: { ...FP, Klaviyo: "k0" } }),
      ),
    ).toEqual([]);
  });

  it("P fingerprints NULL (legacy scan): no removals at all", () => {
    const cur = scan([...many(2, "Klaviyo"), ...many(1, "Reviews App")]);
    expect(detect(cur, prev({ appSignatureFingerprints: null }))).toEqual([]);
    expect(detect(cur, prev({ appSignatureFingerprints: undefined }))).toEqual([]);
  });

  it("malformed fingerprints JSON is treated as never recorded", () => {
    const cur = scan(many(2, "Klaviyo"));
    expect(detect(cur, prev({ appSignatureFingerprints: ["k1"] }))).toEqual([]);
    expect(detect(cur, prev({ appSignatureFingerprints: { Klaviyo: 1 } }))).toEqual([]);
  });

  it("app missing from the fingerprints (either side): not a removal", () => {
    const withoutKlaviyo: Record<string, string> = { ...FP };
    delete withoutKlaviyo.Klaviyo;
    expect(
      detect(scan(many(2, "Klaviyo")), prev({ appSignatureFingerprints: withoutKlaviyo })),
    ).toEqual([]);
    expect(
      detect(scan(many(2, "Klaviyo"), { appSignatureFingerprints: withoutKlaviyo }), prev()),
    ).toEqual([]);
  });

  it("APP-scope ignored app is not a removal", () => {
    const ignores = { fingerprints: new Set<string>(), appNames: new Set(["Klaviyo"]) };
    expect(detect(scan(many(3, "Klaviyo")), prev(), ignores)).toEqual([]);
  });

  it("instance-ignored findings reduce the count, and can zero it", () => {
    const fs = many(3, "Klaviyo");
    const fpOf = (f: RemovalFinding) =>
      fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);
    const one = { fingerprints: new Set([fpOf(fs[0])]), appNames: new Set<string>() };
    expect(detect(scan(fs), prev(), one)).toEqual([{ appName: "Klaviyo", leftoverCount: 2 }]);
    const all = { fingerprints: new Set(fs.map(fpOf)), appNames: new Set<string>() };
    expect(detect(scan(fs), prev(), all)).toEqual([]);
  });

  it("findings with a null appName never count", () => {
    expect(detect(scan([finding(null), finding(null)]), prev())).toEqual([]);
  });

  it("SCRIPT_TAG_SUNSET (a LIVE app's script tags) never counts toward leftovers", () => {
    const tags = many(2, "Klaviyo", { findingType: FindingType.SCRIPT_TAG_SUNSET });
    expect(detect(scan(tags), prev())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live-hook helpers
// ---------------------------------------------------------------------------

describe("parseLiveAppHooks", () => {
  it("parses both sources; null lists stay null (not observed)", () => {
    const parsed = parseLiveAppHooks({ embedApps: ["A"], scriptTagApps: null });
    expect([...(parsed?.embed ?? [])]).toEqual(["A"]);
    expect(parsed?.scriptTag).toBeNull();
  });

  it("NULL / non-object = never recorded; a malformed list = that source not observed", () => {
    expect(parseLiveAppHooks(null)).toBeNull();
    expect(parseLiveAppHooks(["A"])).toBeNull();
    expect(parseLiveAppHooks({ embedApps: [1], scriptTagApps: ["B"] })?.embed).toBeNull();
  });
});

describe("scriptTagHookApps", () => {
  it("returns the sorted, de-duplicated signature apps; host-only groups are skipped", () => {
    expect(
      scriptTagHookApps(
        ["u1", "u2", "u3"],
        [{ appName: "Privy" }, { appName: undefined }, { appName: "Klaviyo" }],
      ),
    ).toEqual(["Klaviyo", "Privy"]);
  });

  it("no script tags: observed and empty", () => {
    expect(scriptTagHookApps([], [])).toEqual([]);
  });

  it("null (not observed) when a detector cap may have dropped an app", () => {
    const urls = Array.from({ length: MAX_SCRIPT_TAG_URLS + 1 }, (_, i) => `u${i}`);
    expect(scriptTagHookApps(urls, [{ appName: "Privy" }])).toBeNull();
    const groups = Array.from({ length: MAX_SCRIPT_TAG_GROUPS }, (_, i) => ({ appName: `A${i}` }));
    expect(scriptTagHookApps(["u"], groups)).toBeNull();
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
    ignores: ShopIgnores = NO_IGNORES,
    previous: RemovalScan | null = prev(),
  ) => nextRemovalState(record, cur, previous, { ignores });

  it("REMOVED -> CLEANED when the app has no findings left, keeping the last count", () => {
    // The count is what was cleaned up: Home says "The 3 items Klaviyo left
    // behind are gone as of this scan".
    expect(next(scan([]))).toEqual({ id: "r1", leftoverCount: 3, state: AppRemovalState.CLEANED });
  });

  it("REMOVED -> REINSTALLED when its embed is back on", () => {
    expect(next(embedOn(["Klaviyo"]))).toEqual({
      id: "r1",
      leftoverCount: 3,
      state: AppRemovalState.REINSTALLED,
    });
  });

  it("REMOVED -> REINSTALLED when its ScriptTag is back, even with leftovers present", () => {
    const cur = scan(many(2, "Klaviyo"), { liveAppHooks: hooks({ scriptTagApps: ["Klaviyo"] }) });
    expect(next(cur)).toMatchObject({ state: AppRemovalState.REINSTALLED });
  });

  it("updates leftoverCount when it changed; null when unchanged", () => {
    expect(next(scan(many(5, "Klaviyo")))).toEqual({ id: "r1", leftoverCount: 5 });
    expect(next(scan(many(3, "Klaviyo")))).toBeNull();
  });

  it("no hook source observed in S: unchanged", () => {
    const blind = { liveAppHooks: hooks({ embedApps: null, scriptTagApps: null }) };
    expect(next(scan([], blind))).toBeNull();
    expect(next(scan([], { liveAppHooks: null }))).toBeNull();
  });

  it("X's category not audited in S (scope revoked): no change", () => {
    const previous = scan(many(3, "Klaviyo", { findingType: FindingType.GHOST_METAFIELD }));
    const cur = scan([], { skippedCategories: [FindingType.GHOST_METAFIELD] });
    expect(next(cur, NO_IGNORES, previous)).toBeNull();
  });

  it("X's leftover file size-skipped in S: no change", () => {
    const previous = scan([finding("Klaviyo", { filename: "layout/theme.liquid" })]);
    expect(
      next(scan([], { skippedFiles: ["layout/theme.liquid"] }), NO_IGNORES, previous),
    ).toBeNull();
  });

  it("previous scan had no visible findings for X (unknown then): no change", () => {
    expect(next(scan([]), NO_IGNORES, scan([]))).toBeNull();
  });

  it("no previous scan: no change (but a returned hook still reads REINSTALLED)", () => {
    expect(next(scan([]), NO_IGNORES, null)).toBeNull();
    expect(next(embedOn(["Klaviyo"]), NO_IGNORES, null)).toMatchObject({
      state: AppRemovalState.REINSTALLED,
    });
  });

  it("APP-ignored app is left unchanged (hiding is not cleaning)", () => {
    expect(next(scan([]), { fingerprints: new Set(), appNames: new Set(["Klaviyo"]) })).toBeNull();
  });

  it("instance ignores reduce the leftover count", () => {
    const fs = many(2, "Klaviyo");
    const ignores = {
      fingerprints: new Set([
        fingerprintFinding(fs[0].filename, fs[0].findingType, fs[0].codeSnippet, fs[0].lineNumber),
      ]),
      appNames: new Set<string>(),
    };
    expect(next(scan(fs), ignores)).toEqual({ id: "r1", leftoverCount: 1 });
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
    const previous = embedOn(["Klaviyo"], many(2, "Privy"));
    const current = scan(many(4, "Klaviyo"));
    const plan = planAppRemovals({
      currentScanId: "s2",
      current,
      previous,
      openRemovals: [{ id: "r1", appName: "Privy", leftoverCount: 2, detectedScanId: "s1" }],
      ignores: NO_IGNORES,
    });
    expect(plan).toEqual({
      creates: [{ appName: "Klaviyo", leftoverCount: 4 }],
      updates: [{ id: "r1", leftoverCount: 2, state: AppRemovalState.CLEANED }],
    });
  });

  it("never re-evaluates a record detected on the current scan (retry safety)", () => {
    const plan = planAppRemovals({
      currentScanId: "s2",
      current: scan([]),
      previous: scan(many(2, "Privy")),
      openRemovals: [{ id: "r1", appName: "Privy", leftoverCount: 2, detectedScanId: "s2" }],
      ignores: NO_IGNORES,
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
      }),
    ).toEqual({ creates: [], updates: [] });
  });
});
