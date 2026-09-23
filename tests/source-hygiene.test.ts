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
