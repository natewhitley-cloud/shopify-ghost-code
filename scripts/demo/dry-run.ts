/** DEMO ONLY (gc-tib.7): splice every removable finding out of a copy of THEME_DIR into OUT_DIR (local files only) and rescan. */
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { spliceSpans } from "../../app/lib/theme-splice";
import { scanThemeFiles } from "../../app/services/scan-engine.server";
const SRC = process.env.THEME_DIR ?? "";
const OUT = resolve(process.env.OUT_DIR ?? "");
// OUT is deleted below: only a fresh folder under the temp dir, never THEME_DIR.
// OUT must be a gc-dryrun-* folder directly in the temp dir, and neither path
// may contain the other (audit r4).
const SRC_ABS = resolve(SRC);
const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
if (
  !SRC ||
  !process.env.OUT_DIR ||
  resolve(OUT, "..") !== resolve(tmpdir()) ||
  !/^gc-dryrun-/.test(OUT.slice(resolve(tmpdir()).length + 1)) ||
  inside(OUT, SRC_ABS) ||
  inside(SRC_ABS, OUT)
) {
  throw new Error("set THEME_DIR, and OUT_DIR to $TMPDIR/gc-dryrun-<name>");
}
rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const load = (root: string) =>
  walk(root)
    .filter((p) => /\.(liquid|json|js|css)$/.test(p))
    .map((p) => ({ filename: relative(root, p), content: readFileSync(p, "utf8") }));
const FIX = ["GHOST_SCRIPT", "GHOST_STYLE", "GHOST_PRECONNECT", "GHOST_SNIPPET"];
const files = load(SRC);
const fix = scanThemeFiles(files).findings.filter(
  (f) => FIX.includes(f.findingType) && f.spanStart !== undefined,
);
const byFile = new Map<string, typeof fix>();
for (const f of fix) byFile.set(f.filename, [...(byFile.get(f.filename) ?? []), f]);
for (const [name, fs] of byFile) {
  const content = files.find((x) => x.filename === name)!.content;
  const r = spliceSpans(
    content,
    fs.map((f) => ({ start: f.spanStart!, end: f.spanEnd! })),
  );
  console.log(
    name,
    "removed",
    r.removed.length,
    "refused",
    JSON.stringify(r.refused.map((x) => x.reason)),
    "bytes",
    content.length,
    "->",
    r.content.length,
  );
  writeFileSync(join(OUT, name), r.content);
}
const after = scanThemeFiles(load(OUT)).findings;
console.log(
  "fixable after:",
  after.filter((f) => FIX.includes(f.findingType)).length,
  "total after:",
  after.length,
  "before:",
  scanThemeFiles(files).findings.length,
);
