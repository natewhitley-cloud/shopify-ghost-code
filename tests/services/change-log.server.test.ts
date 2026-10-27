/**
 * Tests for app/services/change-log.server.ts (gc-rrh.4, spec 2, 3 and 9):
 * the pure change computation and the finding-list diff it shares with the
 * summary email. Built on tests/fixtures/change-log-scans.ts. The guard tests
 * are A/B pairs: the same input with the guarded condition flipped must
 * produce the row, so each guard is proven non-vacuous.
 */
import { FindingType } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The orchestrator's models import the db client; the pure code needs none.
vi.mock("../../app/db.server", () => ({ default: {} }));

import type { ChangeRow } from "../../app/lib/change-log";
import { MAX_CHANGE_ROWS } from "../../app/lib/change-log";
import type { ManifestEntry } from "../../app/lib/theme-manifest";
import type { RemovalNoticeRow } from "../../app/models/app-removal.server";
import type { ShopIgnores } from "../../app/models/ignored-finding.server";
import {
  type ChangeLogScan,
  checkKindFor,
  computeChangeSet,
  countChecksRan,
  diffFindingLists,
} from "../../app/services/change-log.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";
import {
  AFTER_SCAN_ID,
  BEFORE_SCAN_ID,
  DETECTOR_ONLY_FINDING,
  JUDGEME_FILES,
  NEWLY_LIVE_FINDING,
  OTHER_THEME_ID,
  PUSHOWL_REMOVED,
  afterScan,
  beforeScan,
  fakeMd5,
  finding,
  switchScan,
} from "../fixtures/change-log-scans";

const NO_IGNORES: ShopIgnores = { fingerprints: new Set(), appNames: new Set() };

function compute(
  current: ChangeLogScan,
  baseline: ChangeLogScan | null = beforeScan(),
  opts: {
    kind?: "baseline" | "compared" | "theme_switch";
    removals?: RemovalNoticeRow[];
    ignores?: ShopIgnores;
  } = {},
) {
  return computeChangeSet({
    current,
    baseline,
    kind: opts.kind ?? (baseline ? "compared" : "baseline"),
    removals: opts.removals ?? [],
    ignores: opts.ignores ?? NO_IGNORES,
  });
}

const keys = (rows: readonly ChangeRow[]) => rows.map((r) => r.key);
const row = (rows: readonly ChangeRow[], key: string) => rows.find((r) => r.key === key);

/** Replace (or add) manifest entries by path, keeping path order. */
function withEntries(manifest: readonly ManifestEntry[], ...entries: ManifestEntry[]) {
  const byPath = new Map(manifest.map((e) => [e[0], e]));
  for (const e of entries) byPath.set(e[0], e);
  return [...byPath.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
const edited = (manifest: readonly ManifestEntry[], path: string, rev = 5): ManifestEntry => {
  const e = manifest.find((m) => m[0] === path)!;
  return [path, fakeMd5(path, rev), e[2], (e[3] ?? 0) + 60, e[4]];
};

afterEach(() => {
  delete process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED;
});

describe("computeChangeSet: the fixture week (one row per cause)", () => {
  const set = compute(afterScan(), beforeScan(), { removals: [PUSHOWL_REMOVED] });

  it("builds exactly one row per cause, in claim order", () => {
    expect(set.kind).toBe("compared");
    expect(set.baselineScanId).toBe(BEFORE_SCAN_ID);
    expect(keys(set.rows)).toEqual([
      "app_inactive:PushOwl",
      "app_added:Judge.me",
      "file_edit:layout/theme.liquid",
      "file_edit:sections/header.liquid",
    ]);
    expect(set.changeCount).toBe(4);
  });

  it("PushOwl: no longer active, 2 leftovers, worth a look, in its leftovers' lane", () => {
    expect(row(set.rows, "app_inactive:PushOwl")).toMatchObject({
      type: "app_inactive",
      app: "PushOwl",
      lane: "speed",
      leftoverCount: 2,
      worthALook: true,
      files: [],
      scanId: AFTER_SCAN_ID,
    });
  });

  it("Judge.me: added (hook appears, same signature), claims its 3 new files, not worth a look", () => {
    const judgeme = row(set.rows, "app_added:Judge.me")!;
    expect(judgeme).toMatchObject({ type: "app_added", app: "Judge.me", worthALook: false });
    expect(judgeme.lane).toBe("speed");
    expect(judgeme.files.map((f) => [f.path, f.status])).toEqual(
      JUDGEME_FILES.map((p) => [p, "added"]),
    );
  });

  it("the new trustbadge host annotates the changed layout row and makes it worth a look", () => {
    expect(row(set.rows, "file_edit:layout/theme.liquid")).toMatchObject({
      app: null,
      host: "cdn.trustbadge.io",
      scriptFile: "layout/theme.liquid",
      line: 57,
      worthALook: true,
      files: [{ path: "layout/theme.liquid", status: "changed" }],
    });
  });

  it("the header edit is not from a known app, has no issues and is not worth a look", () => {
    expect(row(set.rows, "file_edit:sections/header.liquid")).toMatchObject({
      type: "file_edit",
      app: null,
      lane: "housekeeping",
      worthALook: false,
      noIssuesInNewVersion: true,
    });
  });

  it("noise is a footnote, never a change: editor data, a locale, EComposer churn", () => {
    expect(set.footnotes).toEqual({
      editorDataFiles: 3,
      localeFiles: 1,
      pageBuilderFiles: [{ app: "EComposer", n: 1 }],
    });
  });

  it("counts, worth-a-look and checks ran", () => {
    expect(set.worthALookCount).toBe(2);
    expect(set.counts).toEqual({
      appsAdded: 1,
      appsInactive: 1,
      appsCleaned: 0,
      unknownScripts: 1,
      filesChanged: 5,
      themeUpdates: 0,
      findingsNew: 0,
      findingsFixed: 0,
      security: 0,
    });
    // Every type is live in AFTER except the advisory.
    expect(set.checksRan).toBe(Object.values(FindingType).length - 1);
    expect(set.themeName).toBe("Dawn");
    expect(set.themeVersion).toBe("15.2.0");
  });

  it("the detector-only finding and the newly live type produce nothing", () => {
    expect(set.counts.findingsNew).toBe(0);
    expect(JSON.stringify(set.rows)).not.toContain("SETTINGS_DRIFT");
    expect(JSON.stringify(set.rows)).not.toContain("GHOST_STYLE");
  });

  it("stores no code: no finding snippet reaches the rows", () => {
    const json = JSON.stringify(set);
    expect(json).not.toContain("<script");
    expect(json).not.toContain("pushowl-sdk.js");
  });

  it("is deterministic (same input, same output)", () => {
    expect(compute(afterScan(), beforeScan(), { removals: [PUSHOWL_REMOVED] })).toEqual(set);
  });
});

describe("computeChangeSet: first scan and non-comparable baselines (spec 2.10)", () => {
  it("no baseline: a baseline check with no rows, no footnotes, checks ran only", () => {
    const set = compute(afterScan(), null);
    expect(set).toEqual({
      kind: "baseline",
      baselineScanId: null,
      themeName: "Dawn",
      themeVersion: "15.2.0",
      checksRan: Object.values(FindingType).length - 1,
      changeCount: 0,
      worthALookCount: 0,
      counts: expect.objectContaining({ appsAdded: 0, filesChanged: 0 }),
      rows: [],
      footnotes: { editorDataFiles: 0, localeFiles: 0, pageBuilderFiles: [] },
    });
  });

  it("kind baseline ignores a baseline passed anyway", () => {
    const set = compute(afterScan(), beforeScan(), { kind: "baseline" });
    expect(set.kind).toBe("baseline");
    expect(set.rows).toEqual([]);
  });

  it("an unversioned current scan has 0 checks ran", () => {
    expect(countChecksRan({ ...afterScan().coverage, liveFindingTypes: null })).toBe(0);
  });

  it("checks ran excludes skipped, capped and unreachable categories", () => {
    const coverage = {
      ...afterScan().coverage,
      skippedCategories: [FindingType.GHOST_TAG],
      cappedCategories: [FindingType.GHOST_REDIRECT],
    };
    expect(countChecksRan(coverage)).toBe(Object.values(FindingType).length - 3);
  });
});

describe("computeChangeSet: theme switch and theme update", () => {
  it("a newly published theme: one theme_published row with old and new version, all remaining code files", () => {
    const set = compute(switchScan(), afterScan(), { kind: "theme_switch" });
    expect(set.kind).toBe("theme_switch");
    expect(set.baselineScanId).toBe(AFTER_SCAN_ID);
    expect(keys(set.rows)).toEqual([`theme_published:${OTHER_THEME_ID}`]);
    expect(set.rows[0]).toMatchObject({
      lane: "customers-see-it",
      worthALook: false,
      theme: {
        name: "Dawn",
        version: "15.3.0",
        previousName: "Dawn",
        previousVersion: "15.2.0",
        filesChanged: 2,
      },
    });
    expect(set.counts.themeUpdates).toBe(1);
    // Same hooks on both sides: nothing reads as an app added.
    expect(set.counts.appsAdded).toBe(0);
  });

  it("a theme switch row is emitted even when no code file differs", () => {
    const set = compute(switchScan({ manifest: afterScan().manifest }), afterScan(), {
      kind: "theme_switch",
    });
    expect(set.rows).toHaveLength(1);
    expect(set.rows[0].theme?.filesChanged).toBe(0);
  });

  it("same theme, new version: theme_update takes the remaining code files; app rows keep theirs", () => {
    const set = compute(
      afterScan({
        themeInfo: { name: "Dawn", version: "15.3.0", author: "Shopify", architecture: "os2" },
      }),
    );
    expect(keys(set.rows)).toEqual(["app_added:Judge.me", "theme_update:15.3.0"]);
    const update = row(set.rows, "theme_update:15.3.0")!;
    expect(update.files.map((f) => f.path)).toEqual([
      "layout/theme.liquid",
      "sections/header.liquid",
    ]);
    // The unknown host attaches to the theme row that claimed its file.
    expect(update).toMatchObject({ host: "cdn.trustbadge.io", worthALook: true });
  });

  it("an unknown theme version on one side is not a theme update (theme info missing)", () => {
    const set = compute(afterScan({ themeInfo: null }));
    expect(set.rows.some((r) => r.type === "theme_update")).toBe(false);
  });

  it.each([
    ["the baseline", { current: "15.3.0", before: null }],
    ["the current scan", { current: null, before: "15.2.0" }],
  ])(
    "theme info read but no version on %s: not a theme update, the code edits keep their rows (L2)",
    (_side, v) => {
      const info = (version: string | null) => ({
        name: "Dawn",
        version,
        author: "Shopify",
        architecture: "os2",
      });
      const set = compute(
        afterScan({ themeInfo: info(v.current) }),
        beforeScan({ themeInfo: info(v.before) }),
      );
      expect(set.rows.some((r) => r.type === "theme_update")).toBe(false);
      expect(keys(set.rows)).toContain("file_edit:sections/header.liquid");
    },
  );
});

describe("computeChangeSet: false-positive guards (A/B)", () => {
  it("A/B 1: a new finding in an unchanged file is not a change; the same finding in a changed file is", () => {
    const unchanged = compute(afterScan());
    expect(unchanged.counts.findingsNew).toBe(0);

    const footer = edited(afterScan().manifest, "sections/footer.liquid");
    const changed = compute(afterScan({ manifest: withEntries(afterScan().manifest, footer) }));
    expect(row(changed.rows, "file_edit:sections/footer.liquid")).toMatchObject({
      findingCount: 1,
      findingTypes: [DETECTOR_ONLY_FINDING.findingType],
      // A new HIGH finding makes its row worth a look.
      worthALook: true,
      noIssuesInNewVersion: false,
    });
  });

  it("A/B 2: a newly live type is never new; live in both, it is", () => {
    expect(compute(afterScan()).counts.findingsNew).toBe(0);

    const liveBoth = compute(afterScan(), beforeScan({ coverage: afterScan().coverage }));
    // SETTINGS_DRIFT only: the detector-only GHOST_STYLE stays out (unchanged file).
    expect(liveBoth.counts.findingsNew).toBe(1);
    const settings = liveBoth.rows.find((r) => r.findingTypes?.includes("SETTINGS_DRIFT"));
    expect(settings?.type).toBe("findings_new");
  });

  it("A/B 3: an app hook appearing with a changed signature fingerprint is not 'added'", () => {
    const prints = { ...(beforeScan().appSignatureFingerprints as Record<string, string>) };
    const edited = { ...prints, "Judge.me": "different-version" };
    const set = compute(afterScan(), beforeScan({ appSignatureFingerprints: edited }));
    expect(set.rows.some((r) => r.type === "app_added")).toBe(false);
    // Its new files still show, as that app's file changes (never "added").
    expect(row(set.rows, "app_files:Judge.me")?.files).toHaveLength(3);

    const same = compute(afterScan(), beforeScan({ appSignatureFingerprints: prints }));
    expect(row(same.rows, "app_added:Judge.me")).toBeDefined();
  });

  it("A/B 4: a hook name with no signature (an unverified handle never names one) is never 'added'", () => {
    const hooks = { embedApps: ["EComposer", "Judge.me", "some-handle"], scriptTagApps: [] };
    const set = compute(afterScan({ liveAppHooks: hooks }));
    expect(set.rows.some((r) => r.app === "some-handle")).toBe(false);

    const prints = {
      ...(afterScan().appSignatureFingerprints as Record<string, string>),
      "some-handle": "v1",
    };
    const verified = compute(
      afterScan({ liveAppHooks: hooks, appSignatureFingerprints: prints }),
      beforeScan({ appSignatureFingerprints: prints }),
    );
    expect(row(verified.rows, "app_added:some-handle")).toBeDefined();
  });

  it("A/B 4b: a hook source not observed on both sides never makes an app 'added'", () => {
    const set = compute(
      afterScan(),
      beforeScan({ liveAppHooks: { embedApps: null, scriptTagApps: [] } }),
    );
    // Judge.me still added through its new files (no Judge.me files before).
    expect(row(set.rows, "app_added:Judge.me")).toBeDefined();
    const noFiles = compute(
      afterScan({ manifest: beforeScan().manifest }),
      beforeScan({ liveAppHooks: { embedApps: null, scriptTagApps: [] } }),
    );
    expect(noFiles.rows.some((r) => r.type === "app_added")).toBe(false);
  });

  it("A/B 5: editor-data-only changes give 0 changes (footnote only)", () => {
    const before = beforeScan();
    const settings = edited(before.manifest, "config/settings_data.json");
    const index = edited(before.manifest, "templates/index.json");
    const group = edited(before.manifest, "sections/header-group.json");
    const set = compute(
      beforeScan({ scanId: "s2", manifest: withEntries(before.manifest, settings, index, group) }),
    );
    expect(set.changeCount).toBe(0);
    expect(set.rows).toEqual([]);
    expect(set.footnotes.editorDataFiles).toBe(3);

    const code = edited(before.manifest, "snippets/price.liquid");
    const counted = compute(
      beforeScan({ scanId: "s2", manifest: withEntries(before.manifest, settings, code) }),
    );
    expect(counted.changeCount).toBe(1);
  });

  it("A/B 6: a live page builder rewriting its own file is a footnote; without a live embed it counts", () => {
    const live = compute(afterScan());
    expect(live.rows.some((r) => r.app === "EComposer")).toBe(false);
    expect(live.footnotes.pageBuilderFiles).toEqual([{ app: "EComposer", n: 1 }]);

    // A builder file owned by its exact snippet name only (no filePatterns
    // match: `ecomposer` is not `ecom-`), so the live hook decides.
    const snippet = "snippets/ecomposer.liquid";
    const before = beforeScan({
      manifest: withEntries(beforeScan().manifest, [snippet, fakeMd5(snippet), 10, 1, "EComposer"]),
    });
    const changed: ManifestEntry = [snippet, fakeMd5(snippet, 2), 10, 2, "EComposer"];
    const liveSnippet = compute(
      afterScan({ manifest: withEntries(afterScan().manifest, changed) }),
      before,
    );
    expect(row(liveSnippet.rows, "app_files:EComposer")).toBeUndefined();
    const notLive = compute(
      afterScan({
        manifest: withEntries(afterScan().manifest, changed),
        liveAppHooks: { embedApps: ["Judge.me"], scriptTagApps: [] },
      }),
      before,
    );
    expect(row(notLive.rows, "app_files:EComposer")?.files).toEqual([
      expect.objectContaining({ path: snippet, status: "changed" }),
    ]);
    // The ecom- section still matches the builder's file pattern: a footnote.
    expect(notLive.footnotes.pageBuilderFiles).toEqual([{ app: "EComposer", n: 1 }]);
  });

  it("M6: a page builder's file-pattern file is a footnote even without a live embed hook", () => {
    const set = compute(
      afterScan({ liveAppHooks: { embedApps: ["Judge.me"], scriptTagApps: [] } }),
    );
    expect(row(set.rows, "app_files:EComposer")).toBeUndefined();
    expect(set.footnotes.pageBuilderFiles).toEqual([{ app: "EComposer", n: 1 }]);
  });

  it("M6: a file pattern alone never makes a non-builder app's edit a footnote", () => {
    // Spreadr has filePatterns but is not a content builder.
    const path = "snippets/spreadr-custom.liquid";
    const before = beforeScan({
      manifest: withEntries(beforeScan().manifest, [path, fakeMd5(path), 10, 1, "Spreadr"]),
    });
    const set = compute(
      afterScan({
        manifest: withEntries(afterScan().manifest, [path, fakeMd5(path, 2), 10, 2, "Spreadr"]),
      }),
      before,
    );
    expect(row(set.rows, "app_files:Spreadr")?.files).toEqual([
      expect.objectContaining({ path, status: "changed" }),
    ]);
  });

  it("A/B 6b: a live page builder's ADDED file still counts", () => {
    const after = afterScan();
    const added: ManifestEntry = [
      "sections/ecom-new-page.liquid",
      fakeMd5("x"),
      10,
      1,
      "EComposer",
    ];
    const set = compute(afterScan({ manifest: withEntries(after.manifest, added) }));
    expect(row(set.rows, "app_files:EComposer")?.files).toEqual([
      expect.objectContaining({ path: "sections/ecom-new-page.liquid", status: "added" }),
    ]);
    expect(set.footnotes.pageBuilderFiles).toEqual([{ app: "EComposer", n: 1 }]);
  });

  it("A/B 7: an unknown script in an unchanged file is not new; in a changed file it is", () => {
    const script = {
      filename: "snippets/price.liquid",
      lineNumber: 3,
      url: "https://evil.example/x.js",
      domain: "evil.example",
    };
    const unchanged = compute(
      afterScan({ unknownScripts: [...afterScan().unknownScripts, script] }),
    );
    expect(JSON.stringify(unchanged.rows)).not.toContain("evil.example");

    const after = afterScan();
    const changed = compute(
      afterScan({
        unknownScripts: [...after.unknownScripts, script],
        manifest: withEntries(after.manifest, edited(after.manifest, "snippets/price.liquid")),
      }),
    );
    expect(row(changed.rows, "file_edit:snippets/price.liquid")).toMatchObject({
      host: "evil.example",
      worthALook: true,
    });
    expect(changed.counts.unknownScripts).toBe(2);
  });

  it("an unknown script whose host is matched or benign in ScanDomain is never new", () => {
    const after = afterScan();
    const set = compute(
      afterScan({
        scanDomains: [{ domain: "cdn.trustbadge.io", matched: true, benign: false }],
      }),
    );
    expect(row(set.rows, "file_edit:layout/theme.liquid")?.host).toBeUndefined();
    expect(after.scanDomains).toHaveLength(2);
  });

  it("an unknown script in an unclaimed file (page-builder churn) becomes its own row", () => {
    const after = afterScan();
    const set = compute(
      afterScan({
        unknownScripts: [
          ...after.unknownScripts,
          {
            filename: "sections/ecom-landing-hero.liquid",
            lineNumber: 1,
            url: "https://cdn.spy.io/x.js",
            domain: "cdn.spy.io",
          },
        ],
      }),
    );
    expect(
      row(set.rows, "unknown_script:cdn.spy.io:sections/ecom-landing-hero.liquid"),
    ).toMatchObject({
      type: "unknown_script",
      lane: "unknown",
      worthALook: true,
      app: null,
    });
    expect(set.counts.unknownScripts).toBe(2);
  });

  it("an active-embed app's own-file churn never yields app_added or app_inactive (spec 3)", () => {
    const before = afterScan({ scanId: "s1" });
    const churn = JUDGEME_FILES.map((p) => edited(before.manifest, p));
    const set = compute(afterScan({ manifest: withEntries(before.manifest, ...churn) }), before);
    expect(set.rows.map((r) => r.type)).toEqual(["app_files"]);
    expect(row(set.rows, "app_files:Judge.me")).toMatchObject({
      lane: "housekeeping",
      worthALook: false,
    });
  });

  it("a signature change alone (new owner, same hash) is never a change", () => {
    const before = beforeScan();
    const reowned = before.manifest.map(
      (e): ManifestEntry =>
        e[0] === "snippets/price.liquid" ? [e[0], e[1], e[2], e[3], "Klaviyo"] : e,
    );
    const set = compute(beforeScan({ scanId: "s2", manifest: reowned }));
    expect(set.changeCount).toBe(0);
  });
});

describe("computeChangeSet: coverage guards (reuse the differ semantics)", () => {
  const footerChanged = () => {
    const after = afterScan();
    return withEntries(after.manifest, edited(after.manifest, "sections/footer.liquid"));
  };

  it("a category the baseline did not audit never produces 'new'", () => {
    const set = compute(
      afterScan({ manifest: footerChanged() }),
      beforeScan({
        coverage: { ...beforeScan().coverage, skippedCategories: [FindingType.GHOST_STYLE] },
      }),
    );
    expect(set.counts.findingsNew).toBe(0);
  });

  it("a category the current scan did not audit never produces 'fixed'", () => {
    const after = afterScan();
    const fixedWhenAudited = compute(
      afterScan({
        findings: [],
        manifest: withEntries(after.manifest, edited(after.manifest, "snippets/pushowl.liquid")),
      }),
    );
    expect(fixedWhenAudited.counts.findingsFixed).toBe(2);

    const notAudited = compute(
      afterScan({
        findings: [],
        manifest: withEntries(after.manifest, edited(after.manifest, "snippets/pushowl.liquid")),
        coverage: {
          ...after.coverage,
          skippedCategories: [FindingType.GHOST_SCRIPT, FindingType.GHOST_PRECONNECT],
        },
      }),
    );
    expect(notAudited.counts.findingsFixed).toBe(0);
  });

  it("an unversioned scan: finding rows are skipped, file rows still compute", () => {
    const set = compute(
      afterScan({
        coverage: { ...afterScan().coverage, liveFindingTypes: null },
        manifest: footerChanged(),
      }),
    );
    expect(set.counts.findingsNew).toBe(0);
    expect(row(set.rows, "file_edit:sections/footer.liquid")).toBeDefined();
    expect(set.checksRan).toBe(0);
  });

  it("an ignored finding is never new; ignored known malicious code still is (security)", () => {
    const after = afterScan();
    const malicious = finding({
      filename: "sections/footer.liquid",
      findingType: FindingType.MALICIOUS_SCRIPT,
      severity: "HIGH",
      codeSnippet: '<script src="https://bad.example/skimmer.js"></script>',
    });
    const fp = (f: typeof malicious) =>
      fingerprintFinding(f.filename, f.findingType, f.codeSnippet, f.lineNumber);
    const ignores: ShopIgnores = {
      fingerprints: new Set([fp(DETECTOR_ONLY_FINDING), fp(malicious)]),
      appNames: new Set(),
    };
    const set = compute(
      afterScan({ findings: [...after.findings, malicious], manifest: footerChanged() }),
      beforeScan(),
      { ignores },
    );
    expect(row(set.rows, "security:sections/footer.liquid")).toMatchObject({
      findingCount: 1,
      findingTypes: ["MALICIOUS_SCRIPT"],
    });
    expect(set.counts.findingsNew).toBe(0);
  });
});

describe("computeChangeSet: security, findings and fixes", () => {
  const malicious = finding({
    filename: "sections/footer.liquid",
    findingType: FindingType.MALICIOUS_SCRIPT,
    severity: "HIGH",
    codeSnippet: '<script src="https://bad.example/skimmer.js"></script>',
  });

  it("new known malicious code is a security row, always worth a look, even in an unchanged file", () => {
    const set = compute(afterScan({ findings: [...afterScan().findings, malicious] }));
    expect(set.rows[0]).toMatchObject({
      key: "security:sections/footer.liquid",
      type: "security",
      lane: "security",
      worthALook: true,
      files: [],
      findingCount: 1,
    });
    expect(set.counts.security).toBe(1);
  });

  it("a security row claims its changed file, so no file_edit row repeats it", () => {
    const after = afterScan();
    const set = compute(
      afterScan({
        findings: [...after.findings, malicious],
        manifest: withEntries(after.manifest, edited(after.manifest, "sections/footer.liquid")),
      }),
    );
    expect(row(set.rows, "security:sections/footer.liquid")?.files).toEqual([
      expect.objectContaining({ path: "sections/footer.liquid", status: "changed" }),
    ]);
    expect(row(set.rows, "file_edit:sections/footer.liquid")).toBeUndefined();
    // The detector-only GHOST_STYLE in the now-changed file attaches to it.
    expect(row(set.rows, "security:sections/footer.liquid")).toMatchObject({
      findingCount: 2,
      securityCount: 1,
    });
    // Counted by finding type, not by row (L1): the attached GHOST_STYLE is a
    // new finding, not a second security issue.
    expect(set.counts.security).toBe(1);
    expect(set.counts.findingsNew).toBe(1);
  });

  it("a new affected-app advisory is a security row while advisories are shown", () => {
    process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
    const advisory = finding({
      filename: "layout/theme.liquid",
      findingType: FindingType.APP_INCIDENT_ADVISORY,
      appName: "Klaviyo",
      severity: "HIGH",
    });
    const allLive = { ...afterScan().coverage, liveFindingTypes: Object.values(FindingType) };
    const set = compute(
      afterScan({ findings: [...afterScan().findings, advisory], coverage: allLive }),
      beforeScan({ coverage: allLive }),
    );
    expect(row(set.rows, "security:layout/theme.liquid")).toMatchObject({
      app: "Klaviyo",
      findingTypes: ["APP_INCIDENT_ADVISORY"],
      worthALook: true,
    });
  });

  it("store-data findings skip the file guard and group by lane; HIGH makes the group worth a look", () => {
    const product = (id: number, severity: string) =>
      finding({
        filename: `products/gid://shopify/Product/${id}`,
        findingType: FindingType.GHOST_TAG,
        lineNumber: 0,
        codeSnippet: `tag-${id}`,
        severity,
      });
    const set = compute(
      afterScan({ findings: [...afterScan().findings, product(1, "LOW"), product(2, "HIGH")] }),
    );
    const group = set.rows.find((r) => r.type === "findings_new")!;
    expect(group).toMatchObject({
      findingCount: 2,
      findingTypes: ["GHOST_TAG"],
      worthALook: true,
      files: [],
    });
    expect(group.key).toBe(`findings_new:${group.lane}`);
    expect(set.counts.findingsNew).toBe(2);
  });

  it("fixed findings attach to the row that claimed their file; others group as one fixed row", () => {
    const after = afterScan();
    const storeFix = finding({
      filename: "redirects/gid://shopify/UrlRedirect/9",
      findingType: FindingType.GHOST_REDIRECT,
      lineNumber: 0,
      codeSnippet: "/apps/old",
    });
    const set = compute(
      afterScan({
        findings: [],
        manifest: withEntries(after.manifest, edited(after.manifest, "snippets/pushowl.liquid")),
      }),
      beforeScan({ findings: [...beforeScan().findings, storeFix] }),
    );
    expect(row(set.rows, "app_files:PushOwl")).toMatchObject({ fixedCount: 2 });
    expect(row(set.rows, "findings_fixed")).toMatchObject({
      lane: "housekeeping",
      worthALook: false,
      fixedCount: 1,
      findingTypes: ["GHOST_REDIRECT"],
    });
    expect(set.counts.findingsFixed).toBe(3);
  });

  it("app cleaned: an AppRemoval turned CLEANED claims that app's removed files", () => {
    const before = beforeScan();
    const set = compute(
      beforeScan({
        scanId: "s2",
        findings: [],
        manifest: before.manifest.filter((e) => e[0] !== "snippets/pushowl.liquid"),
      }),
      before,
      { removals: [{ appName: "PushOwl", leftoverCount: 2, state: "CLEANED" }] },
    );
    expect(keys(set.rows)).toEqual(["app_cleaned:PushOwl"]);
    expect(set.rows[0]).toMatchObject({
      lane: "housekeeping",
      worthALook: false,
      leftoverCount: 2,
      fixedCount: 2,
      files: [expect.objectContaining({ path: "snippets/pushowl.liquid", status: "removed" })],
    });
  });

  it("an app no longer active with 0 leftovers is not worth a look", () => {
    const set = compute(afterScan(), beforeScan(), {
      removals: [{ ...PUSHOWL_REMOVED, leftoverCount: 0 }],
    });
    expect(row(set.rows, "app_inactive:PushOwl")?.worthALook).toBe(false);
  });
});

describe("computeChangeSet: grouping, renames and caps", () => {
  const SNIPPETS = Array.from(
    { length: 12 },
    (_, i) => `snippets/custom-${String(i).padStart(2, "0")}.liquid`,
  );
  const added = (p: string): ManifestEntry => [p, fakeMd5(p), 10, 1, null];

  it("up to 3 unattributed edits: one row each", () => {
    const before = beforeScan();
    const set = compute(
      beforeScan({
        scanId: "s2",
        manifest: withEntries(before.manifest, ...SNIPPETS.slice(0, 3).map(added)),
      }),
    );
    expect(keys(set.rows)).toEqual(SNIPPETS.slice(0, 3).map((p) => `file_edit:${p}`));
  });

  it("more than 3: one group row, 10 files listed plus moreFiles", () => {
    const before = beforeScan();
    const set = compute(
      beforeScan({ scanId: "s2", manifest: withEntries(before.manifest, ...SNIPPETS.map(added)) }),
    );
    expect(keys(set.rows)).toEqual(["files_edit_group"]);
    expect(set.rows[0].files).toHaveLength(10);
    expect(set.rows[0].moreFiles).toBe(2);
    expect(set.rows[0].noIssuesInNewVersion).toBe(true);
    expect(set.counts.filesChanged).toBe(12);
    expect(set.changeCount).toBe(1);
  });

  it("a rename (same checksum, new path) is one renamed file, not an add and a remove", () => {
    const before = beforeScan();
    const old = before.manifest.find((e) => e[0] === "snippets/price.liquid")!;
    const renamed = before.manifest
      .filter((e) => e !== old)
      .concat([["snippets/price-v2.liquid", old[1], old[2], old[3], null]])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const set = compute(beforeScan({ scanId: "s2", manifest: renamed }));
    expect(set.rows).toEqual([
      expect.objectContaining({
        key: "file_edit:snippets/price-v2.liquid",
        files: [expect.objectContaining({ path: "snippets/price-v2.liquid", status: "renamed" })],
      }),
    ]);
  });

  it("a removed unattributed file is a file_edit with no 'no issues' claim", () => {
    const before = beforeScan();
    const set = compute(
      beforeScan({
        scanId: "s2",
        manifest: before.manifest.filter((e) => e[0] !== "snippets/price.liquid"),
      }),
    );
    expect(set.rows[0]).toMatchObject({ key: "file_edit:snippets/price.liquid" });
    expect(set.rows[0].noIssuesInNewVersion).toBeUndefined();
    expect(set.rows[0].files[0]).toEqual({
      path: "snippets/price.liquid",
      status: "removed",
      changedAt: null,
    });
  });

  it("static assets (images, fonts) are neither changes nor footnotes", () => {
    const before = beforeScan();
    const set = compute(
      beforeScan({
        scanId: "s2",
        manifest: withEntries(before.manifest, edited(before.manifest, "assets/logo.png")),
      }),
    );
    expect(set.changeCount).toBe(0);
    expect(set.footnotes).toEqual({ editorDataFiles: 0, localeFiles: 0, pageBuilderFiles: [] });
  });

  it(`caps stored rows at ${MAX_CHANGE_ROWS}, keeping worth-a-look rows; the counts stay true`, () => {
    const apps = Array.from({ length: 60 }, (_, i) => `App${String(i).padStart(2, "0")}`);
    const prints = Object.fromEntries(apps.map((a) => [a, "v1"]));
    const before = beforeScan();
    const settings = edited(before.manifest, "config/settings_data.json");
    const set = compute(
      beforeScan({
        scanId: "s2",
        liveAppHooks: { embedApps: ["EComposer", "PushOwl", ...apps], scriptTagApps: [] },
        appSignatureFingerprints: prints,
        manifest: withEntries(before.manifest, settings),
        unknownScripts: [
          {
            filename: "config/settings_data.json",
            lineNumber: 1,
            url: "https://cdn.late.io/x.js",
            domain: "cdn.late.io",
          },
        ],
      }),
      beforeScan({ appSignatureFingerprints: prints }),
    );
    expect(set.changeCount).toBe(61);
    expect(set.worthALookCount).toBe(1);
    expect(set.counts.appsAdded).toBe(60);
    expect(set.rows).toHaveLength(MAX_CHANGE_ROWS);
    expect(set.rows.at(-1)?.type).toBe("unknown_script");
  });
});

describe("diffFindingLists (shared with the summary email)", () => {
  const advisory = finding({
    filename: "layout/theme.liquid",
    findingType: FindingType.APP_INCIDENT_ADVISORY,
  });
  const args = () => {
    const after = afterScan();
    const live = Object.values(FindingType);
    return {
      currentFindings: [...after.findings, advisory],
      currentCoverage: { ...after.coverage, liveFindingTypes: live },
      currentLiveFindingTypes: live,
      baseline: {
        ...beforeScan().coverage,
        findings: beforeScan().findings,
        liveFindingTypes: live,
      },
      ignores: NO_IGNORES,
    };
  };

  it("lists new and fixed findings; advisories only when included", () => {
    process.env.APP_INCIDENT_ADVISORY_LIVE_ENABLED = "true";
    const withAdvisories = diffFindingLists(args(), { includeAdvisories: true });
    const email = diffFindingLists(args(), { includeAdvisories: false });
    if (!withAdvisories.ok || !email.ok) throw new Error("expected ok");
    expect(withAdvisories.newFindings.map((f) => f.findingType).sort()).toEqual(
      ["APP_INCIDENT_ADVISORY", "GHOST_STYLE", "SETTINGS_DRIFT"].sort(),
    );
    expect(email.newFindings.map((f) => f.findingType).sort()).toEqual(
      ["GHOST_STYLE", "SETTINGS_DRIFT"].sort(),
    );
    expect(email.openCount).toBe(4);
    expect(email.fixedFindings).toEqual([]);
  });

  it("code in a menu is a security row in the change log but stays out of the email (gc-7gjj.1)", () => {
    const menu = finding({
      filename: "menus/1/items/2/0badc0de",
      findingType: FindingType.MENU_INJECTION,
    });
    const base = args();
    const withMenu = { ...base, currentFindings: [...base.currentFindings, menu] };
    const log = diffFindingLists(withMenu, { includeAdvisories: true });
    const email = diffFindingLists(withMenu, { includeAdvisories: false });
    if (!log.ok || !email.ok) throw new Error("expected ok");
    expect(log.newFindings.map((f) => f.findingType)).toContain("MENU_INJECTION");
    expect(email.newFindings.map((f) => f.findingType)).not.toContain("MENU_INJECTION");
    expect(email.openCount).toBe(4);
  });

  it("an unversioned side cannot be judged (baseline checked first)", () => {
    expect(
      diffFindingLists(
        {
          ...args(),
          baseline: { ...args().baseline, liveFindingTypes: null },
          currentLiveFindingTypes: null,
        },
        { includeAdvisories: false },
      ),
    ).toEqual({ ok: false, reason: "baseline_unversioned" });
    expect(
      diffFindingLists({ ...args(), currentLiveFindingTypes: null }, { includeAdvisories: false }),
    ).toEqual({ ok: false, reason: "current_unversioned" });
  });

  it("the fixture's newly live type is never new", () => {
    const a = afterScan();
    const b = beforeScan();
    const diff = diffFindingLists(
      {
        currentFindings: a.findings,
        currentCoverage: a.coverage,
        currentLiveFindingTypes: a.coverage.liveFindingTypes,
        baseline: {
          ...b.coverage,
          findings: b.findings,
          liveFindingTypes: b.coverage.liveFindingTypes,
        },
        ignores: NO_IGNORES,
      },
      { includeAdvisories: true },
    );
    if (!diff.ok) throw new Error("expected ok");
    expect(diff.newFindings.map((f) => f.filename)).toEqual([DETECTOR_ONLY_FINDING.filename]);
    expect(diff.newFindings).not.toContainEqual(
      expect.objectContaining({ filename: NEWLY_LIVE_FINDING.filename }),
    );
  });
});

describe("checkKindFor", () => {
  it.each([
    ["SCHEDULED", "Professional", "weekly"],
    ["SCHEDULED", "Standard", "monthly"],
    ["AUTO_PUBLISH", "Professional", "publish"],
    ["MANUAL", "Professional", "manual"],
    ["MANUAL", "Free", "manual"],
  ])("%s on %s is a %s check", (origin, plan, kind) => {
    expect(checkKindFor(origin, plan)).toBe(kind);
  });
});
