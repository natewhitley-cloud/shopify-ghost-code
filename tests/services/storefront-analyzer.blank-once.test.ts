/**
 * The checkout guard analyzer blanks the page's comments ONCE and hands the
 * blanked page to every reader (wave 4 LOW): the known-malicious walk, the
 * guard regions and its own walk used to blank it again each. The results
 * are unchanged (the full analyzer suite runs on the same code).
 */
import { describe, it, expect, vi } from "vitest";

const blank = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../app/services/scan-engine.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/scan-engine.server")>();
  return {
    ...actual,
    blankInertComments: (content: string, filename: string) => {
      blank.calls += 1;
      return actual.blankInertComments(content, filename);
    },
  };
});

import { analyzeStorefrontHtml } from "../../app/services/storefront-analyzer.server";

describe("analyzeStorefrontHtml blanks comments once", () => {
  it("one blankInertComments pass per page, same signals", () => {
    const html =
      `<!-- <nav><script src="https://hidden.example/a.js"></script></nav> -->` +
      `<nav><script src="https://newhost.example/a.js"></script></nav>` +
      `<script src="https://cb28utrk.com/x.js"></script>` +
      `<img src=x onerror="fetch('https://beacon.example/c')">`;
    blank.calls = 0;
    const r = analyzeStorefrontHtml(html);
    expect(blank.calls).toBe(1);
    expect(r.maliciousHits.map((h) => h.domain)).toEqual(["cb28utrk.com"]);
    expect(r.loaders.map((l) => l.fingerprint).sort()).toEqual([
      "SCRIPT_LOADER:beacon.example",
      "SCRIPT_LOADER:newhost.example",
    ]);
    expect(r.hosts.map((h) => h.host)).toEqual(["newhost.example"]);
  });
});
