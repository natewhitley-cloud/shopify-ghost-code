/**
 * Source hygiene guard (gc-pho).
 *
 * A raw NUL byte (0x00) in a source file makes grep and other text tools treat
 * the file as binary, silently hiding it from code search. Write the character
 * as a JS escape sequence (e.g. "\u0000") instead of embedding the raw byte.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIRS = ["app", "inngest", "tests", "scripts"];
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|json|liquid|css|md|prisma|toml)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE_EXT_RE.test(entry.name)) out.push(path);
  }
  return out;
}

describe("source hygiene", () => {
  it("contains no raw NUL bytes in source files", () => {
    const offenders = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
      .filter((path) => readFileSync(path).includes(0))
      .map((path) => path.slice(REPO_ROOT.length));
    expect(offenders).toEqual([]);
  });
});

/**
 * Brand-name guard: the product is "GhostCode" (one word) everywhere a merchant
 * sees it. Fails if the two-word form (capital G, capital C) comes back, or if
 * the two words are used in any letter case as a plain phrase for what the
 * scanner finds: merchant copy says "leftover code" for that.
 *
 * Scope: every non-comment line of the .ts/.tsx files under app/ (routes,
 * components, lib, and the services that build emails and the PDF), which
 * covers string literals and JSX text alike.
 * Not checked: comment lines (starting with `//`, `*`, `/*` or `{/*`), which
 * merchants never see; a phrase split across two lines; and inngest/, whose
 * only use is an Inngest function's internal name.
 * A trailing comment on a code line IS checked: reword it.
 */
function appCodeLinesMatching(pattern: RegExp): string[] {
  return sourceFiles(join(REPO_ROOT, "app"))
    .filter((path) => /\.tsx?$/.test(path))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, i) => ({ line, where: `${path.slice(REPO_ROOT.length)}:${i + 1}` }))
        .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line))
        .filter(({ line }) => pattern.test(line))
        .map(({ where }) => where),
    );
}

describe("brand name", () => {
  it('merchant copy under app/ says "GhostCode", never the two-word form', () => {
    expect(appCodeLinesMatching(/Ghost Code/)).toEqual([]);
  });

  it('merchant copy under app/ says "leftover code", never the two words as a plain phrase', () => {
    expect(
      appCodeLinesMatching(/ghost\s+code/i),
      'Write "leftover code" (or "GhostCode" for the product name) on these lines',
    ).toEqual([]);
  });
});
