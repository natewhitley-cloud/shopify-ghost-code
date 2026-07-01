/**
 * Benchmark harness: scanThemeFilesInPool vs inline scanThemeFiles (GC-8uw).
 *
 * Measures event-loop delay under concurrent scans when the CPU work is
 * offloaded to Piscina worker threads vs the inline (main-thread) baseline.
 *
 * Run with:
 *   npm run bench:pool
 *
 * (bench:pool calls `npm run build:worker` first, then this script.)
 *
 * Expected outcome: pool path drops event-loop p99 from ~350–400ms → ~2–5ms.
 */

import { scanThemeFiles, type ThemeFile } from "../app/services/scan-engine.server";
import { destroyPool, scanThemeFilesInPool } from "../app/services/scan-pool.server";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONCURRENCY = 5;
const IDLE_SAMPLE_MS = 1_500;
const LOAD_SETTLE_MS = 500;

// ---------------------------------------------------------------------------
// Fixture (mirrors bench-scan-engine.ts — large 200-file theme)
// ---------------------------------------------------------------------------

const GHOST_CONTENT = `
<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=XXXX"></script>
<link rel="stylesheet" href="https://cdn.judge.me/assets/v4/widget.css" />
{% render 'recharge-checkout-option' %}
{% render 'klaviyo-onsite' %}
<link rel="alternate" hreflang="fr" href="https://fr.example.com/" />
<link rel="alternate" hreflang="de" href="https://de.example.com/" />
<script type="application/ld+json">
{
  "@type": "Product",
  "url": "https://judge.me/reviews"
}
</script>
<meta name="robots" content="noindex" />
<link rel="canonical" href="" />
<title></title>
<meta property="og:title" content="" />
<link rel="preconnect" href="https://static.klaviyo.com" />
<script>
  fetch('https://app.someoldapp.io/api/cart', { method: 'POST', body: JSON.stringify(cart) });
</script>
`.trim();

const CLEAN_CONTENT = `
{%- liquid
  assign og_title = page_title | default: shop.name
  assign og_url = canonical_url | default: request.origin
-%}
<title>{{ page_title }} – {{ shop.name }}</title>
<meta property="og:site_name" content="{{ shop.name }}">
<h1>{{ shop.name }}</h1>
{{ content_for_layout }}
`.trim();

function buildFixture(fileCount: number, label: string): ThemeFile[] {
  const files: ThemeFile[] = [];
  files.push({ filename: "layout/theme.liquid", content: GHOST_CONTENT });
  for (let i = 1; i < fileCount; i++) {
    const isGhost = i % 3 === 0;
    const dir = i % 2 === 0 ? "snippets" : "sections";
    files.push({
      filename: `${dir}/${label}-file-${i}.liquid`,
      content: isGhost ? GHOST_CONTENT : CLEAN_CONTENT,
    });
  }
  return files;
}

const LARGE_THEME = buildFixture(200, "large");

// ---------------------------------------------------------------------------
// Probe + percentile helpers (same as bench-scan-engine.ts)
// ---------------------------------------------------------------------------

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)];
}

function startELDProbe(intervalMs: number): { stop: () => number[] } {
  const delays: number[] = [];
  let lastTick = performance.now();
  const id = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - lastTick - intervalMs));
    lastTick = now;
  }, intervalMs);
  return { stop: () => { clearInterval(id); return delays; } };
}

async function measureIdleELD(durationMs: number): Promise<{ p50Ms: number; p99Ms: number }> {
  const probe = startELDProbe(10);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const samples = probe.stop().sort((a, b) => a - b);
  return { p50Ms: percentile(samples, 50), p99Ms: percentile(samples, 99) };
}

// ---------------------------------------------------------------------------
// Inline (baseline) — same approach as bench-scan-engine.ts
// ---------------------------------------------------------------------------

async function measureInlineELD(
  files: ThemeFile[],
  concurrency: number,
): Promise<{ p50Ms: number; p99Ms: number }> {
  const probe = startELDProbe(10);

  const scans = Array.from(
    { length: concurrency },
    () =>
      new Promise<void>((resolve) =>
        setImmediate(() => {
          scanThemeFiles(files);
          resolve();
        }),
      ),
  );
  await Promise.all(scans);
  await new Promise((resolve) => setTimeout(resolve, LOAD_SETTLE_MS));

  const samples = probe.stop().sort((a, b) => a - b);
  return { p50Ms: percentile(samples, 50), p99Ms: percentile(samples, 99) };
}

// ---------------------------------------------------------------------------
// Pool path
// ---------------------------------------------------------------------------

async function measurePoolELD(
  files: ThemeFile[],
  concurrency: number,
): Promise<{ p50Ms: number; p99Ms: number }> {
  const probe = startELDProbe(10);

  // Warm up — one run to initialise worker threads before we measure.
  await scanThemeFilesInPool(files);

  const scans = Array.from({ length: concurrency }, () => scanThemeFilesInPool(files));
  await Promise.all(scans);
  await new Promise((resolve) => setTimeout(resolve, LOAD_SETTLE_MS));

  const samples = probe.stop().sort((a, b) => a - b);
  return { p50Ms: percentile(samples, 50), p99Ms: percentile(samples, 99) };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toFixed(2).padStart(8);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Ghost Code — scan-pool vs inline benchmark (GC-8uw)");
  console.log(`Fixture: ${LARGE_THEME.length} files  |  Concurrency: ${CONCURRENCY}`);

  console.log("\nSampling idle event-loop delay…");
  const idle = await measureIdleELD(IDLE_SAMPLE_MS);

  console.log(`Running ${CONCURRENCY} INLINE concurrent scans for ELD measurement…`);
  const inlineLoad = await measureInlineELD(LARGE_THEME, CONCURRENCY);

  console.log(`Running ${CONCURRENCY} POOL concurrent scans for ELD measurement…`);
  const poolLoad = await measurePoolELD(LARGE_THEME, CONCURRENCY);

  console.log("\n=== Event-Loop Delay: inline vs pool ===");
  console.log(
    `${"Condition".padEnd(40)} ${"p50 (ms)".padStart(10)} ${"p99 (ms)".padStart(10)}`,
  );
  console.log("-".repeat(62));
  console.log(`${"Idle (no scans)".padEnd(40)} ${fmt(idle.p50Ms)} ${fmt(idle.p99Ms)}`);
  console.log(
    `${"Inline (blocking)".padEnd(40)} ${fmt(inlineLoad.p50Ms)} ${fmt(inlineLoad.p99Ms)}`,
  );
  console.log(`${"Pool (worker threads)".padEnd(40)} ${fmt(poolLoad.p50Ms)} ${fmt(poolLoad.p99Ms)}`);
  console.log(
    `${"Delta inline→pool p99".padEnd(40)} ${fmt(0).trim().padStart(8)} ${fmt(poolLoad.p99Ms - inlineLoad.p99Ms)}`,
  );

  console.log("\nDone.");

  await destroyPool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
