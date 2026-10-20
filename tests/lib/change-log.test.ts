/**
 * Tests for app/lib/change-log.ts (gc-rrh.4): countRows and mergeChangeSets,
 * the keyed merge behind Standard's month groups and the email's period.
 */
import { describe, expect, it } from "vitest";

import {
  type ChangeRow,
  countRows,
  emptyCounts,
  emptyFootnotes,
  type MergeableChangeSet,
  mergeChangeSets,
} from "../../app/lib/change-log";

function row(over: Partial<ChangeRow> & Pick<ChangeRow, "key" | "type">): ChangeRow {
  return {
    app: null,
    lane: "housekeeping",
    worthALook: false,
    files: [],
    moreFiles: 0,
    scanId: "scan-1",
    ...over,
  };
}

const file = (path: string) => ({ path, status: "changed" as const, changedAt: 1 });

function set(
  createdAt: string,
  rows: ChangeRow[],
  over: Partial<MergeableChangeSet> = {},
): MergeableChangeSet {
  return { kind: "compared", createdAt, rows, footnotes: emptyFootnotes(), ...over };
}

describe("countRows", () => {
  it("adds up each count from its row type", () => {
    const counts = countRows([
      row({ key: "security:a", type: "security", findingCount: 2, files: [file("a")] }),
      row({ key: "app_inactive:X", type: "app_inactive", leftoverCount: 3 }),
      row({ key: "app_cleaned:Y", type: "app_cleaned", fixedCount: 1 }),
      row({ key: "app_added:Z", type: "app_added", files: [file("b"), file("c")] }),
      row({ key: "theme_update:2", type: "theme_update", files: [file("d")], moreFiles: 4 }),
      row({
        key: "file_edit:e",
        type: "file_edit",
        files: [file("e")],
        host: "h.io",
        findingCount: 1,
      }),
      row({ key: "unknown_script:h:f", type: "unknown_script", files: [file("f")], host: "h" }),
      row({ key: "findings_new:speed", type: "findings_new", findingCount: 4 }),
      row({ key: "findings_fixed", type: "findings_fixed", fixedCount: 5 }),
    ]);
    expect(counts).toEqual({
      appsAdded: 1,
      appsInactive: 1,
      appsCleaned: 1,
      unknownScripts: 2,
      // unknown_script rows annotate; their file is not a counted change.
      filesChanged: 1 + 2 + 5 + 1,
      themeUpdates: 1,
      findingsNew: 5,
      findingsFixed: 6,
      security: 2,
    });
  });

  it("no rows: all zero", () => {
    expect(countRows([])).toEqual(emptyCounts());
  });
});

describe("mergeChangeSets", () => {
  it("dedupes rows by key; the latest check's row wins", () => {
    const merged = mergeChangeSets([
      set("2026-10-05T06:40:00Z", [
        row({ key: "file_edit:sections/header.liquid", type: "file_edit", scanId: "w1" }),
        row({
          key: "app_inactive:PushOwl",
          type: "app_inactive",
          leftoverCount: 2,
          worthALook: true,
          scanId: "w1",
        }),
      ]),
      set("2026-10-12T06:40:00Z", [
        row({
          key: "app_inactive:PushOwl",
          type: "app_inactive",
          leftoverCount: 1,
          worthALook: true,
          scanId: "w2",
        }),
        row({ key: "app_added:Judge.me", type: "app_added", scanId: "w2" }),
      ]),
    ]);
    expect(merged.rows.map((r) => [r.key, r.scanId])).toEqual([
      ["app_inactive:PushOwl", "w2"],
      ["app_added:Judge.me", "w2"],
      ["file_edit:sections/header.liquid", "w1"],
    ]);
    expect(merged.rows[0].leftoverCount).toBe(1);
    expect(merged.changeCount).toBe(3);
    expect(merged.worthALookCount).toBe(1);
    expect(merged.counts.appsInactive).toBe(1);
    expect(merged.checks).toBe(2);
  });

  it("the latest state wins even when it is no longer worth a look", () => {
    const merged = mergeChangeSets([
      set("2026-10-05T00:00:00Z", [
        row({ key: "file_edit:a", type: "file_edit", worthALook: true, host: "x" }),
      ]),
      set("2026-10-12T00:00:00Z", [row({ key: "file_edit:a", type: "file_edit" })]),
    ]);
    expect(merged.worthALookCount).toBe(0);
    expect(merged.counts.unknownScripts).toBe(0);
  });

  it("input order does not matter: checks apply oldest first", () => {
    const older = set("2026-10-05T00:00:00Z", [
      row({ key: "k", type: "file_edit", scanId: "old" }),
    ]);
    const newer = set("2026-10-12T00:00:00Z", [
      row({ key: "k", type: "file_edit", scanId: "new" }),
    ]);
    expect(mergeChangeSets([newer, older]).rows[0].scanId).toBe("new");
    expect(mergeChangeSets([older, newer]).rows[0].scanId).toBe("new");
  });

  it("footnotes add up across checks, page builders per app", () => {
    const merged = mergeChangeSets([
      set("2026-10-05T00:00:00Z", [], {
        footnotes: {
          editorDataFiles: 2,
          localeFiles: 1,
          pageBuilderFiles: [{ app: "PageFly", n: 3 }],
        },
      }),
      set("2026-10-12T00:00:00Z", [], {
        footnotes: {
          editorDataFiles: 1,
          localeFiles: 0,
          pageBuilderFiles: [
            { app: "PageFly", n: 1 },
            { app: "EComposer", n: 2 },
          ],
        },
      }),
    ]);
    expect(merged.footnotes).toEqual({
      editorDataFiles: 3,
      localeFiles: 1,
      pageBuilderFiles: [
        { app: "EComposer", n: 2 },
        { app: "PageFly", n: 4 },
      ],
    });
    expect(merged.changeCount).toBe(0);
  });

  it("a baseline check adds no rows but counts as a check", () => {
    const merged = mergeChangeSets([
      set("2026-10-05T00:00:00Z", [row({ key: "stray", type: "file_edit" })], { kind: "baseline" }),
      set("2026-10-12T00:00:00Z", [row({ key: "file_edit:a", type: "file_edit" })]),
    ]);
    expect(merged.rows.map((r) => r.key)).toEqual(["file_edit:a"]);
    expect(merged.checks).toBe(2);
  });

  it("rows keep claim order by type across checks", () => {
    const merged = mergeChangeSets([
      set("2026-10-05T00:00:00Z", [
        row({ key: "findings_fixed", type: "findings_fixed", fixedCount: 1 }),
      ]),
      set("2026-10-12T00:00:00Z", [
        row({ key: "security:a", type: "security", findingCount: 1, worthALook: true }),
      ]),
    ]);
    expect(merged.rows.map((r) => r.type)).toEqual(["security", "findings_fixed"]);
  });

  it("no checks: an empty merge", () => {
    expect(mergeChangeSets([])).toEqual({
      rows: [],
      counts: emptyCounts(),
      footnotes: emptyFootnotes(),
      changeCount: 0,
      worthALookCount: 0,
      checks: 0,
    });
  });
});
