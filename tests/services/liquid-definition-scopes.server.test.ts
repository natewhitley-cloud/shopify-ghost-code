/**
 * gc-dza: isThemeDefinedVar was rewritten from a per-token `.some()` over every
 * scope of a name to a precomputed earliest-assign + disjoint-loop-interval
 * binary search. This property test asserts the new answers are EXACTLY those
 * of the original implementation (re-implemented below as the oracle) over
 * seeded random Liquid, including offsets exactly on tag boundaries.
 */

import { describe, expect, it } from "vitest";

import { isThemeDefinedVar, liquidDefinitionScopes } from "../../app/services/scan-engine.server";

// --- Oracle: the pre-gc-dza implementation, verbatim in behavior. ---
type OldScope = { from: number; to: number };
const STATEMENT_RE =
  /^[ \t]*(assign|capture|for|tablerow|endfor|endtablerow)\b(?:[ \t]+([A-Za-z_][\w-]*))?/gm;

function oldScopes(content: string): Map<string, OldScope[]> {
  const scopes = new Map<string, OldScope[]>();
  const openLoops: OldScope[] = [];
  let from = 0;
  for (;;) {
    const open = content.indexOf("{%", from);
    if (open === -1) break;
    const close = content.indexOf("%}", open + 2);
    if (close === -1) break;
    const body = content.slice(open + 2, close).replace(/^-/, "");
    for (const m of body.matchAll(STATEMENT_RE)) {
      const [, keyword, name] = m;
      if (keyword === "endfor" || keyword === "endtablerow") {
        const loop = openLoops.pop();
        if (loop) loop.to = open;
      } else if (name) {
        const scope = { from: open, to: Infinity };
        const list = scopes.get(name);
        if (list) list.push(scope);
        else scopes.set(name, [scope]);
        if (keyword === "for" || keyword === "tablerow") openLoops.push(scope);
      }
    }
    from = close + 2;
  }
  return scopes;
}

function oldIsDefined(token: string, scopes: Map<string, OldScope[]>, offset: number): boolean {
  const name = /^\{\{-?\s*([A-Za-z_][\w-]*)/.exec(token)?.[1];
  if (!name) return false;
  return scopes.get(name)?.some((s) => s.from < offset && offset < s.to) ?? false;
}

// --- Seeded deterministic generator (mulberry32). ---
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["x", "y", "item"];

function generate(rand: () => number): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const parts: string[] = [];
  const n = 1 + Math.floor(rand() * 14);
  for (let i = 0; i < n; i++) {
    const r = rand();
    const name = pick(NAMES);
    if (r < 0.22) parts.push(`{% for ${name} in list %}`);
    else if (r < 0.3) parts.push(`{%- tablerow ${name} in list -%}`);
    else if (r < 0.42) parts.push("{% endfor %}");
    else if (r < 0.46) parts.push("{% endtablerow %}");
    else if (r < 0.54) parts.push(`{% assign ${name} = 1 %}`);
    else if (r < 0.6) parts.push(`{% capture ${name} %}`);
    else if (r < 0.66) {
      // `{% liquid %}` multi-statement tag: several statements share one offset.
      parts.push(
        `{% liquid\n for ${name} in list\n for ${pick(NAMES)} in list\n assign ${pick(NAMES)} = 2\n%}`,
      );
    } else if (r < 0.7) parts.push(`{% for ${name} in a %}{% endfor %}`);
    else parts.push(`{{ ${pick(NAMES)} }}`, ` text `);
  }
  return parts.join(rand() < 0.5 ? "" : "\n");
}

describe("liquidDefinitionScopes / isThemeDefinedVar equivalence (gc-dza)", () => {
  it("matches the original .some() implementation on seeded random Liquid", () => {
    const rand = rng(0xd2a);
    let cases = 0;
    let trueAnswers = 0;
    let falseAnswers = 0;
    let firstMismatch: string | null = null;
    for (let i = 0; i < 1500 && firstMismatch === null; i++) {
      const content = generate(rand);
      const old = oldScopes(content);
      const next = liquidDefinitionScopes(content);

      // Probe every offset (covers each boundary exactly), plus out-of-range.
      // Plain comparison per probe; expect() with a stringified message on each
      // of ~100k probes made this test flake against the suite timeout.
      for (let offset = -1; offset <= content.length + 1; offset++) {
        for (const name of [...NAMES, "unknown"]) {
          const token = `{{ ${name} }}`;
          const expected = oldIsDefined(token, old, offset);
          if (isThemeDefinedVar(token, next, offset) !== expected && firstMismatch === null) {
            firstMismatch = `${name}@${offset} expected ${expected} in ${JSON.stringify(content)}`;
          }
          cases++;
          if (expected) trueAnswers++;
          else falseAnswers++;
        }
      }
    }
    expect(firstMismatch).toBeNull();
    // Guard against a vacuous generator: both outcomes must be well exercised.
    expect(cases).toBeGreaterThan(100_000);
    expect(trueAnswers).toBeGreaterThan(5_000);
    expect(falseAnswers).toBeGreaterThan(5_000);
  });

  it("keeps touching loop intervals apart (boundary offset is in neither)", () => {
    // for scope 1 ends at the endfor tag (offset 16); scope 2 starts at the
    // next tag. Offsets strictly between stay undefined.
    const content = "{% for x in a %}{% endfor %}{% for x in b %}{% endfor %}";
    const old = oldScopes(content);
    const next = liquidDefinitionScopes(content);
    for (let o = 0; o <= content.length; o++) {
      expect(isThemeDefinedVar("{{ x }}", next, o)).toBe(oldIsDefined("{{ x }}", old, o));
    }
  });

  it("handles whitespace-control and non-variable tokens like before", () => {
    const content = "{% assign seo_title = a %}{{- seo_title -}}";
    const next = liquidDefinitionScopes(content);
    expect(isThemeDefinedVar("{{- seo_title | escape }}", next, 30)).toBe(true);
    expect(isThemeDefinedVar("{{ 'str' }}", next, 30)).toBe(false);
  });
});
