/** DEMO ONLY (gc-tib.7): scan a pulled theme folder (THEME_DIR) with the real scan engine and list removable findings. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { scanThemeFiles } from "../../app/services/scan-engine.server";
const ROOT = process.env.THEME_DIR!;
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(ROOT)
  .filter((p) => /\.(liquid|json|js|css)$/.test(p))
  .map((p) => ({ filename: relative(ROOT, p), content: readFileSync(p, "utf8") }));
const { findings } = scanThemeFiles(files);
const fix = ["GHOST_SCRIPT", "GHOST_STYLE", "GHOST_PRECONNECT", "GHOST_SNIPPET"];
console.log(
  "total",
  findings.length,
  "by type",
  JSON.stringify(
    findings.reduce<Record<string, number>>(
      (a, f) => ((a[f.findingType] = (a[f.findingType] ?? 0) + 1), a),
      {},
    ),
  ),
);
for (const f of findings.filter((x) => fix.includes(x.findingType)))
  console.log(
    f.findingType,
    f.filename,
    f.lineNumber,
    f.appName,
    f.spanStart !== undefined ? "SPAN" : "nospan",
  );
