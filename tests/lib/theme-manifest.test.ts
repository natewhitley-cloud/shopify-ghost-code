import { describe, it, expect } from "vitest";

import {
  buildManifestEntries,
  diffManifests,
  entryChanged,
  extractAppBlockRefs,
  MANIFEST_VERSION,
  MAX_APP_BLOCK_REFS,
  manifestBytes,
  type ManifestEntry,
  type ManifestFileMeta,
  parseManifestEntries,
} from "../../app/lib/theme-manifest";

const A = "0cc175b9c0f1b6a831c399e269772661";
const B = "92eb5ffee6ae2fec3ad71c777531578f";
const C = "4a8a08f09d37b73795649038408b5f33";
const EMPTY = "d41d8cd98f00b204e9800998ecf8427e";
const T1 = "2026-10-05T06:40:00Z";
const T1_SEC = Date.parse(T1) / 1000;

function meta(filename: string, over: Partial<ManifestFileMeta> = {}): ManifestFileMeta {
  return { filename, checksumMd5: A, size: 10, updatedAt: T1, ...over };
}

function entry(
  path: string,
  md5: string | null = A,
  over: Partial<{ size: number | null; at: number | null; owner: string | null }> = {},
): ManifestEntry {
  return [
    path,
    md5,
    over.size === undefined ? 10 : over.size,
    over.at === undefined ? 100 : over.at,
    over.owner ?? null,
  ];
}

describe("buildManifestEntries", () => {
  it("empty theme: no entries", () => {
    expect(buildManifestEntries([])).toEqual([]);
  });

  it("sorts by path and encodes [path, md5, size, updatedAtEpochSec, ownerApp]", () => {
    const entries = buildManifestEntries(
      [
        meta("snippets/b.liquid"),
        meta("assets/logo.png", { checksumMd5: B, size: 2048 }),
        meta("layout/theme.liquid"),
      ],
      (path) => (path === "snippets/b.liquid" ? "Klaviyo" : null),
    );
    expect(entries).toEqual([
      ["assets/logo.png", B, 2048, T1_SEC, null],
      ["layout/theme.liquid", A, 10, T1_SEC, null],
      ["snippets/b.liquid", A, 10, T1_SEC, "Klaviyo"],
    ]);
  });

  it("binary files are entries like any other (metadata, no content)", () => {
    const [png] = buildManifestEntries([meta("assets/hero.webp", { size: 5_000_000 })]);
    expect(png).toEqual(["assets/hero.webp", A, 5_000_000, T1_SEC, null]);
  });

  it("keeps null md5, size and updatedAt as null; an unparseable time is null", () => {
    expect(
      buildManifestEntries([
        meta("a.liquid", { checksumMd5: null, size: null, updatedAt: null }),
        meta("b.liquid", { updatedAt: "not a date" }),
      ]),
    ).toEqual([
      ["a.liquid", null, null, null, null],
      ["b.liquid", A, 10, null, null],
    ]);
  });

  it("a path reported twice keeps its first report", () => {
    expect(
      buildManifestEntries([
        meta("a.liquid", { checksumMd5: A }),
        meta("a.liquid", { checksumMd5: B }),
      ]),
    ).toEqual([["a.liquid", A, 10, T1_SEC, null]]);
  });

  it("never stores content: each entry is exactly five scalars", () => {
    const entries = buildManifestEntries([meta("layout/theme.liquid")]);
    for (const e of entries) {
      expect(e).toHaveLength(5);
      expect(e.every((v) => v === null || typeof v !== "object")).toBe(true);
    }
  });

  it("equal themes give byte-identical JSON whatever the fetch order", () => {
    const a = buildManifestEntries([meta("b"), meta("a"), meta("c")]);
    const b = buildManifestEntries([meta("c"), meta("b"), meta("a")]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(manifestBytes(a)).toBe(manifestBytes(b));
  });

  it("manifestBytes is the UTF-8 length of the stored JSON", () => {
    const entries = buildManifestEntries([meta("snippets/café.liquid")]);
    expect(manifestBytes(entries)).toBe(Buffer.byteLength(JSON.stringify(entries), "utf8"));
    expect(manifestBytes([])).toBe(2);
  });

  it("MANIFEST_VERSION is 1 (the schema default)", () => {
    expect(MANIFEST_VERSION).toBe(1);
  });
});

describe("parseManifestEntries", () => {
  it("round-trips built entries through JSON", () => {
    const entries = buildManifestEntries(
      [meta("a.liquid"), meta("b.png", { checksumMd5: null })],
      () => "X",
    );
    expect(parseManifestEntries(JSON.parse(JSON.stringify(entries)))).toEqual(entries);
  });

  it("accepts an empty manifest", () => {
    expect(parseManifestEntries([])).toEqual([]);
  });

  it.each([
    ["null", null],
    ["object", {}],
    ["short tuple", [["a", A, 1, 2]]],
    ["path not a string", [[1, A, 1, 2, null]]],
    ["md5 not a string", [["a", 5, 1, 2, null]]],
    ["size a string", [["a", A, "1", 2, null]]],
    ["time NaN-like", [["a", A, 1, "x", null]]],
    ["owner a number", [["a", A, 1, 2, 3]]],
  ])("rejects a malformed value as a whole (%s)", (_label, raw) => {
    expect(parseManifestEntries(raw)).toBeNull();
  });
});

describe("entryChanged", () => {
  it("checksums decide when both sides have one, whatever size or time say", () => {
    expect(entryChanged(entry("a", A, { size: 1, at: 1 }), entry("a", A, { size: 2, at: 2 }))).toBe(
      false,
    );
    expect(entryChanged(entry("a", A), entry("a", B))).toBe(true);
  });

  it("either md5 null: size + updatedAt decide", () => {
    expect(entryChanged(entry("a", null, { size: 1 }), entry("a", A, { size: 2 }))).toBe(true);
    expect(entryChanged(entry("a", A, { at: 1 }), entry("a", null, { at: 2 }))).toBe(true);
    expect(entryChanged(entry("a", null), entry("a", null))).toBe(false);
  });

  it("nothing comparable: unchanged (never a false change)", () => {
    expect(
      entryChanged(entry("a", null, { size: null, at: null }), entry("a", A, { size: 5, at: 9 })),
    ).toBe(false);
  });

  it("an owner-app change alone is not a change", () => {
    expect(entryChanged(entry("a", A, { owner: null }), entry("a", A, { owner: "PageFly" }))).toBe(
      false,
    );
  });
});

describe("diffManifests", () => {
  it("identical manifests: nothing", () => {
    const m = [entry("a"), entry("b", B)];
    expect(diffManifests(m, m)).toEqual({ added: [], removed: [], changed: [], renamed: [] });
  });

  it("empty baseline: every file added; empty current: every file removed", () => {
    const m = [entry("a", A), entry("b", B)];
    expect(diffManifests([], m).added).toEqual(m);
    expect(diffManifests(m, []).removed).toEqual(m);
  });

  it("added, removed and changed, each in path order", () => {
    const d = diffManifests(
      [entry("keep", A), entry("edit", A), entry("gone-z", B), entry("gone-a", C)],
      [entry("keep", A), entry("edit", B), entry("new-b", "e1"), entry("new-a", "e2")],
    );
    expect(d.added.map((e) => e[0])).toEqual(["new-a", "new-b"]);
    expect(d.removed.map((e) => e[0])).toEqual(["gone-a", "gone-z"]);
    expect(d.changed).toEqual([{ before: entry("edit", A), after: entry("edit", B) }]);
    expect(d.renamed).toEqual([]);
  });

  it("renamed = removed + added with the same md5; neither appears as added or removed", () => {
    const d = diffManifests([entry("snippets/old.liquid", B)], [entry("snippets/new.liquid", B)]);
    expect(d.renamed).toEqual([
      { from: entry("snippets/old.liquid", B), to: entry("snippets/new.liquid", B) },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("renames pair one to one, in path order; a surplus copy stays added", () => {
    const d = diffManifests([entry("old-1", B)], [entry("copy-a", B), entry("copy-b", B)]);
    expect(d.renamed.map((r) => [r.from[0], r.to[0]])).toEqual([["old-1", "copy-a"]]);
    expect(d.added.map((e) => e[0])).toEqual(["copy-b"]);
  });

  it("null md5 and the empty-file md5 never pair a rename", () => {
    const d = diffManifests(
      [entry("old-null", null), entry("old-empty", EMPTY)],
      [entry("new-null", null), entry("new-empty", EMPTY)],
    );
    expect(d.renamed).toEqual([]);
    expect(d.added.map((e) => e[0])).toEqual(["new-empty", "new-null"]);
    expect(d.removed.map((e) => e[0])).toEqual(["old-empty", "old-null"]);
  });

  it("deleted files: removed only", () => {
    const d = diffManifests([entry("a"), entry("b", B)], [entry("a")]);
    expect(d).toEqual({ added: [], removed: [entry("b", B)], changed: [], renamed: [] });
  });

  it("theme switch: two themes' manifests compare by hash (identical files are not changes)", () => {
    const dawn152 = [entry("layout/theme.liquid", A), entry("sections/header.liquid", B)];
    const dawn153 = [
      entry("layout/theme.liquid", A, { at: 999 }),
      entry("sections/header.liquid", C),
    ];
    const d = diffManifests(dawn152, dawn153);
    expect(d.changed.map((c) => c.after[0])).toEqual(["sections/header.liquid"]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe("extractAppBlockRefs (spec 2.9)", () => {
  const settings = JSON.stringify({
    current: {
      blocks: {
        "1": { type: "shopify://apps/judgeme/blocks/judgeme_core/61ccd3b1-a9f2", disabled: false },
        "2": { type: "shopify://apps/ecomposer-builder/blocks/app-embed/abc", disabled: true },
      },
    },
  });

  it("reads blocks from settings_data, JSON templates and section groups only", () => {
    const refs = extractAppBlockRefs([
      { filename: "config/settings_data.json", content: settings },
      {
        filename: "templates/product.json",
        content:
          '/* comment header */ {"sections":{"m":{"blocks":{"r":{"type":"shopify://apps/judgeme/blocks/review_widget/xyz"}}}}}',
      },
      { filename: "sections/footer-group.json", content: '"shopify://apps/klaviyo/blocks/form/1"' },
      // Code files and locales are never read for refs.
      { filename: "sections/main.liquid", content: '"shopify://apps/nope/blocks/x/1"' },
      { filename: "locales/en.default.json", content: '"shopify://apps/nope/blocks/x/1"' },
    ]);
    expect(refs).toEqual([
      { handle: "ecomposer-builder", block: "app-embed", file: "config/settings_data.json" },
      { handle: "judgeme", block: "judgeme_core", file: "config/settings_data.json" },
      { handle: "klaviyo", block: "form", file: "sections/footer-group.json" },
      { handle: "judgeme", block: "review_widget", file: "templates/product.json" },
    ]);
  });

  it("no editor data or no refs: empty", () => {
    expect(extractAppBlockRefs([])).toEqual([]);
    expect(extractAppBlockRefs([{ filename: "templates/index.json", content: "{}" }])).toEqual([]);
  });

  it("deduplicates per file and caps the stored list", () => {
    const many = Array.from(
      { length: MAX_APP_BLOCK_REFS + 50 },
      (_, i) => `"shopify://apps/app${i}/blocks/b/1"`,
    ).join(",");
    const twice = '"shopify://apps/a/blocks/b/1","shopify://apps/a/blocks/b/2"';
    expect(
      extractAppBlockRefs([{ filename: "templates/index.json", content: twice }]),
    ).toHaveLength(1);
    expect(extractAppBlockRefs([{ filename: "templates/index.json", content: many }])).toHaveLength(
      MAX_APP_BLOCK_REFS,
    );
  });

  it("keeps only handle, block and file (no surrounding content)", () => {
    const [ref] = extractAppBlockRefs([
      { filename: "config/settings_data.json", content: settings },
    ]);
    expect(Object.keys(ref).sort()).toEqual(["block", "file", "handle"]);
  });
});
