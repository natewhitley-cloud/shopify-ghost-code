/**
 * Tests for scan-pool.server.ts (GC-8uw).
 *
 * Golden equivalence: the pool path must return byte-for-byte identical results
 * to the inline synchronous scan.  This is the regression guard on the worker
 * thread boundary — if serialisation ever silently drops fields, this fails.
 *
 * This test file uses the REAL Piscina pool.  The worker is compiled via
 * build:worker in beforeAll so the test is self-contained.  CI does not need
 * to run build before test.
 *
 * Pool teardown: destroyPool() in afterAll ensures the worker threads are
 * joined before the process exits (no hanging test process).
 */

import { execSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scanThemeFiles, type ThemeFile } from "../../app/services/scan-engine.server";
import { destroyPool, scanThemeFilesInPool } from "../../app/services/scan-pool.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Liquid with findings across several detector categories. */
const GHOST_LIQUID = `
<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=XXXX"></script>
<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css" />
{% render 'recharge-checkout-option' %}
<link rel="alternate" hreflang="fr" href="https://fr.example.com/" />
<meta name="robots" content="noindex" />
<link rel="canonical" href="" />
<title></title>
<meta property="og:title" content="" />
<link rel="preconnect" href="https://static.klaviyo.com" />
<script>
  fetch('https://app.someoldapp.io/api/cart', { method: 'POST', body: JSON.stringify(cart) });
</script>
`.trim();

/** Clean Liquid that produces no findings. */
const CLEAN_LIQUID = `
{%- liquid
  assign og_title = page_title | default: shop.name
-%}
<title>{{ page_title }} – {{ shop.name }}</title>
<meta property="og:site_name" content="{{ shop.name }}">
{{ content_for_layout }}
`.trim();

const REPRESENTATIVE_FILES: ThemeFile[] = [
  { filename: "layout/theme.liquid", content: GHOST_LIQUID },
  { filename: "sections/header.liquid", content: CLEAN_LIQUID },
  { filename: "snippets/klaviyo-onsite.liquid", content: CLEAN_LIQUID },
  { filename: "templates/index.liquid", content: GHOST_LIQUID },
];

const EMPTY_FILES: ThemeFile[] = [];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Compile the worker so the pool can resolve it even on a fresh checkout
  // that hasn't run `npm run build` yet.
  execSync("npm run build:worker", { cwd: process.cwd(), stdio: "pipe" });
}, 30_000);

afterAll(async () => {
  await destroyPool();
});

// ---------------------------------------------------------------------------
// Golden equivalence
// ---------------------------------------------------------------------------

describe("scanThemeFilesInPool — golden equivalence", () => {
  it("produces identical findings to inline scan for a mixed-content theme", async () => {
    const poolResult = await scanThemeFilesInPool(REPRESENTATIVE_FILES);
    const inlineResult = scanThemeFiles(REPRESENTATIVE_FILES);

    expect(poolResult.findings).toEqual(inlineResult.findings);
    expect(poolResult.unknownScripts).toEqual(inlineResult.unknownScripts);
  });

  it("returns empty findings for a clean theme (no false positives)", async () => {
    const cleanFiles: ThemeFile[] = [
      { filename: "layout/theme.liquid", content: CLEAN_LIQUID },
      { filename: "sections/header.liquid", content: CLEAN_LIQUID },
    ];

    const poolResult = await scanThemeFilesInPool(cleanFiles);
    const inlineResult = scanThemeFiles(cleanFiles);

    expect(poolResult.findings).toEqual(inlineResult.findings);
    expect(poolResult.unknownScripts).toEqual(inlineResult.unknownScripts);
    expect(poolResult.findings).toHaveLength(0);
  });

  it("handles empty file list without error", async () => {
    const poolResult = await scanThemeFilesInPool(EMPTY_FILES);
    const inlineResult = scanThemeFiles(EMPTY_FILES);

    expect(poolResult.findings).toEqual(inlineResult.findings);
    expect(poolResult.unknownScripts).toEqual(inlineResult.unknownScripts);
  });
});
