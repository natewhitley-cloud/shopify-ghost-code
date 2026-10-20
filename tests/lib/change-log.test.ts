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
  // Stored totals default to what the rows add up to (an uncapped check).
  return {
    kind: "compared",
    createdAt,
    rows,
    footnotes: emptyFootnotes(),
    counts: countRows(rows),
    changeCount: rows.length,
    worthALookCount: rows.filter((r) => r.worthALook).length,
    ...over,
  };
}

const files = (prefix: string, n: number, changedAt = 1) =>
  Array.from({ length: n }, (_, i) => ({
    path: `${prefix}${String(i).padStart(2, "0")}.liquid`,
    status: "changed" as const,
    changedAt,
  }));

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

  describe("aggregate rows add up across checks (M3)", () => {
    it("files_edit_group unions files and findings_new sums counts (5 files + 7 new, then 4 + 1)", () => {
      const merged = mergeChangeSets([
        set("2026-10-05T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: files("sections/a", 5),
            scanId: "w1",
          }),
          row({
            key: "findings_new:speed",
            type: "findings_new",
            lane: "speed",
            findingCount: 7,
            findingTypes: ["RENDER_BLOCKING_SCRIPT"],
          }),
        ]),
        set("2026-10-12T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: files("snippets/b", 4, 2),
            scanId: "w2",
          }),
          row({
            key: "findings_new:speed",
            type: "findings_new",
            lane: "speed",
            findingCount: 1,
            findingTypes: ["UNUSED_APP_CODE"],
          }),
        ]),
      ]);
      const group = merged.rows.find((r) => r.key === "files_edit_group")!;
      expect(group.files.length + group.moreFiles).toBe(9);
      expect(group.files).toHaveLength(9);
      expect(group.scanId).toBe("w2");
      const fresh = merged.rows.find((r) => r.key === "findings_new:speed")!;
      expect(fresh.findingCount).toBe(8);
      expect(fresh.findingTypes).toEqual(["RENDER_BLOCKING_SCRIPT", "UNUSED_APP_CODE"]);
      expect(merged.counts.filesChanged).toBe(9);
      expect(merged.counts.findingsNew).toBe(8);
      expect(merged.changeCount).toBe(2);
    });

    it("a file in both checks' groups is one file, with the newer check's status and changedAt", () => {
      const merged = mergeChangeSets([
        set("2026-10-05T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: [
              { path: "a.liquid", status: "added", changedAt: 1 },
              { path: "b.liquid", status: "changed", changedAt: 1 },
            ],
          }),
        ]),
        set("2026-10-12T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: [
              { path: "b.liquid", status: "changed", changedAt: 9 },
              { path: "c.liquid", status: "removed", changedAt: null },
            ],
          }),
        ]),
      ]);
      expect(merged.rows[0].files).toEqual([
        { path: "a.liquid", status: "added", changedAt: 1 },
        { path: "b.liquid", status: "changed", changedAt: 9 },
        { path: "c.liquid", status: "removed", changedAt: null },
      ]);
      expect(merged.counts.filesChanged).toBe(3);
    });

    it("the union is listed up to 10 files; the rest, and each check's unlisted files, are counted", () => {
      const merged = mergeChangeSets([
        set("2026-10-05T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: files("a", 10),
            moreFiles: 3,
          }),
        ]),
        set("2026-10-12T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: files("b", 4),
            moreFiles: 0,
          }),
        ]),
      ]);
      const group = merged.rows[0];
      expect(group.files).toHaveLength(10);
      expect(group.moreFiles).toBe(4 + 3);
      expect(merged.counts.filesChanged).toBe(17);
    });

    it("findings_fixed sums fixes across checks", () => {
      const merged = mergeChangeSets([
        set("2026-10-05T00:00:00Z", [
          row({ key: "findings_fixed", type: "findings_fixed", fixedCount: 3 }),
        ]),
        set("2026-10-12T00:00:00Z", [
          row({ key: "findings_fixed", type: "findings_fixed", fixedCount: 2 }),
        ]),
      ]);
      expect(merged.rows[0].fixedCount).toBe(5);
      expect(merged.counts.findingsFixed).toBe(5);
    });

    it("worth a look if either check's row was (a new HIGH finding is never dropped by a quiet later check)", () => {
      const merged = mergeChangeSets([
        set("2026-10-05T00:00:00Z", [
          row({
            key: "findings_new:privacy",
            type: "findings_new",
            findingCount: 1,
            worthALook: true,
          }),
        ]),
        set("2026-10-12T00:00:00Z", [
          row({ key: "findings_new:privacy", type: "findings_new", findingCount: 1 }),
        ]),
      ]);
      expect(merged.rows[0].worthALook).toBe(true);
      expect(merged.worthALookCount).toBe(1);
    });

    it("no issues in the new version only if neither check's group had one", () => {
      const merged = mergeChangeSets([
        set("2026-10-05T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: files("a", 4),
            noIssuesInNewVersion: false,
          }),
        ]),
        set("2026-10-12T00:00:00Z", [
          row({
            key: "files_edit_group",
            type: "files_edit_group",
            files: files("b", 4),
            noIssuesInNewVersion: true,
          }),
        ]),
      ]);
      expect(merged.rows[0].noIssuesInNewVersion).toBe(false);
    });

    it("a single-thing key still takes the latest row (not summed)", () => {
      const merged = mergeChangeSets([
        set("2026-10-05T00:00:00Z", [
          row({ key: "file_edit:a", type: "file_edit", findingCount: 2, files: [file("a")] }),
        ]),
        set("2026-10-12T00:00:00Z", [
          row({ key: "file_edit:a", type: "file_edit", findingCount: 1, files: [file("a")] }),
        ]),
      ]);
      expect(merged.rows[0].findingCount).toBe(1);
      expect(merged.counts.findingsNew).toBe(1);
    });
  });

  describe("stored totals beyond the 50-row cap (L5)", () => {
    const capped = (createdAt: string, scanId: string) =>
      set(
        createdAt,
        [row({ key: `file_edit:${scanId}`, type: "file_edit", files: [file(scanId)] })],
        {
          // 60 rows computed, 1 stored: 59 more file edits and 1 more fix.
          counts: { ...emptyCounts(), filesChanged: 60, findingsFixed: 1 },
          changeCount: 61,
          worthALookCount: 0,
        },
      );

    it("a single check reports exactly its stored counts and changeCount", () => {
      const merged = mergeChangeSets([capped("2026-10-05T00:00:00Z", "w1")]);
      expect(merged.counts).toEqual({ ...emptyCounts(), filesChanged: 60, findingsFixed: 1 });
      expect(merged.changeCount).toBe(61);
      expect(merged.rows).toHaveLength(1);
    });

    it("merged checks add each check's unstored overflow to the merged rows' counts", () => {
      const merged = mergeChangeSets([
        capped("2026-10-05T00:00:00Z", "w1"),
        capped("2026-10-12T00:00:00Z", "w2"),
      ]);
      expect(merged.counts.filesChanged).toBe(2 + 59 * 2);
      expect(merged.counts.findingsFixed).toBe(2);
      expect(merged.changeCount).toBe(2 + 60 * 2);
    });

    it("worth-a-look rows beyond the cap still count", () => {
      const merged = mergeChangeSets([
        set(
          "2026-10-05T00:00:00Z",
          [row({ key: "security:a", type: "security", worthALook: true })],
          {
            worthALookCount: 3,
            changeCount: 3,
          },
        ),
      ]);
      expect(merged.worthALookCount).toBe(3);
      expect(merged.changeCount).toBe(3);
    });
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
