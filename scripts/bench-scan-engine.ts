/**
 * Benchmark harness for scanThemeFiles (GC-8uw).
 *
 * Measures:
 *   1. Per-scan wall-time (p50 / p99) across small and large theme fixtures.
 *   2. Event-loop delay (p50 / p99) during N concurrent scans vs idle baseline.
 *
 * Run with:
 *   npx vite-node scripts/bench-scan-engine.ts
 *
 * Or via npm alias:
 *   npm run bench:scan
 *
 * This script imports production code directly — it is a measurement harness,
 * not a correctness test.  No mocks, no Vitest.
 */

// monitorEventLoopDelay (node:perf_hooks) was considered but its V8-internal
// sampling hook can't interrupt the setImmediate check-phase mid-drain; we
// use a manual setInterval probe instead (see startELDProbe below).

import { scanThemeFiles, type ThemeFile } from "../app/services/scan-engine.server";

// ---------------------------------------------------------------------------
// Configuration — tweak if you want more precision or faster runs
// ---------------------------------------------------------------------------

/** Wall-time iterations per fixture. ≥30 is enough for stable p50/p99. */
const WALL_TIME_ITERATIONS = 40;

/**
 * Number of concurrent scan() calls used for the event-loop delay measurement.
 * Mirrors realistic load: 5 Inngest invocations overlapping in one process.
 */
const CONCURRENCY = 5;

/** Idle baseline sampling window (ms) before running scans. */
const IDLE_SAMPLE_MS = 1_500;

/** How long (ms) to wait for all concurrent scans to settle before reading the histogram. */
const LOAD_SETTLE_MS = 200;

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

/**
 * Representative ghost-code content covering all major detector categories.
 * Matches real Liquid found in post-uninstall theme audits.
 */
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

/** Clean Liquid content that produces no findings — exercises the skip path. */
const CLEAN_CONTENT = `
{%- liquid
  assign og_title = page_title | default: shop.name
  assign og_url = canonical_url | default: request.origin
-%}
<title>{{ page_title }} – {{ shop.name }}</title>
<meta property="og:site_name" content="{{ shop.name }}">
<meta property="og:url" content="{{ og_url }}">
<meta property="og:title" content="{{ og_title | escape }}">
<h1>{{ shop.name }}</h1>
<p>Welcome to our store.</p>
{{ content_for_layout }}
`.trim();

/** Builds a ThemeFile array of the requested size. */
function buildFixture(fileCount: number, label: string): ThemeFile[] {
  const files: ThemeFile[] = [];

  // layout/theme.liquid — one per theme, carries the most detectors
  files.push({ filename: "layout/theme.liquid", content: GHOST_CONTENT });

  // Mix of sections and snippets to fill the file count.
  // ~30% ghost, ~70% clean — representative of a real partially-cleaned theme.
  for (let i = 1; i < fileCount; i++) {
    const isGhost = i % 3 === 0;
    const isSnippet = i % 2 === 0;
    const dir = isSnippet ? "snippets" : "sections";
    files.push({
      filename: `${dir}/${label}-file-${i}.liquid`,
      content: isGhost ? GHOST_CONTENT : CLEAN_CONTENT,
    });
  }

  return files;
}

/**
 * Small fixture: ~25 files — analogous to a minimal/starter theme.
 * Built by hand-sizing to represent the low end of real merchant themes.
 */
const SMALL_THEME = buildFixture(25, "small");

/**
 * Large fixture: ~200 files — analogous to a heavily customised Dawn theme.
 * Built by scaling representative content; ~30% ghost files mirrors typical
 * post-uninstall state.  Real themes average 180-250 Liquid files.
 */
const LARGE_THEME = buildFixture(200, "large");

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Wall-time measurement
// ---------------------------------------------------------------------------

interface WallResult {
  label: string;
  fileCount: number;
  p50Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

function measureWallTime(label: string, files: ThemeFile[], iterations: number): WallResult {
  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    scanThemeFiles(files);
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);

  return {
    label,
    fileCount: files.length,
    p50Ms: percentile(samples, 50),
    p99Ms: percentile(samples, 99),
    minMs: samples[0],
    maxMs: samples[samples.length - 1],
  };
}

// ---------------------------------------------------------------------------
// Event-loop delay measurement
// ---------------------------------------------------------------------------

interface ELDResult {
  label: string;
  p50Ms: number;
  p99Ms: number;
}

/**
 * Manual event-loop delay measurement using a setInterval probe.
 *
 * Sets up a 10ms interval and measures how much later than scheduled each
 * callback fires.  This is more transparent than monitorEventLoopDelay because
 * it uses the same timer mechanism as real in-process code (HTTP handlers, etc.)
 * rather than an internal V8 sampling hook.
 *
 * Returns sorted delay samples so the caller can compute percentiles.
 */
function startELDProbe(intervalMs: number): { stop: () => number[] } {
  const delays: number[] = [];
  let lastTick = performance.now();

  const id = setInterval(() => {
    const now = performance.now();
    const delay = now - lastTick - intervalMs;
    delays.push(Math.max(0, delay));
    lastTick = now;
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(id);
      return delays;
    },
  };
}

/** Sample event-loop delay for `durationMs` with no activity. */
async function measureIdleELD(durationMs: number): Promise<ELDResult> {
  const probe = startELDProbe(10);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const samples = probe.stop().sort((a, b) => a - b);

  return {
    label: "idle",
    p50Ms: percentile(samples, 50),
    p99Ms: percentile(samples, 99),
  };
}

/**
 * Schedule `concurrency` scans via setImmediate, measuring event-loop delay
 * with a manual interval probe throughout.
 *
 * setImmediate is used so each scan occupies a separate check-phase turn;
 * a Promise.resolve().then() approach drains all microtasks in one pass,
 * which the interval probe (a timer/macrotask) can't interrupt — it would
 * see only one giant sample and report misleadingly high p50 or low p99
 * depending on sampling alignment.
 *
 * This mimics real Inngest behaviour: each HTTP request arrives as an I/O
 * callback (macrotask), runs synchronously to scanThemeFiles, then returns.
 * The event loop CAN interleave other callbacks between individual scans.
 */
async function measureLoadELD(files: ThemeFile[], concurrency: number): Promise<ELDResult> {
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

  // Settle: give the interval probe a few more ticks to capture post-scan baseline.
  await new Promise((resolve) => setTimeout(resolve, LOAD_SETTLE_MS));
  const samples = probe.stop().sort((a, b) => a - b);

  return {
    label: `${concurrency} concurrent scans (large fixture)`,
    p50Ms: percentile(samples, 50),
    p99Ms: percentile(samples, 99),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toFixed(2).padStart(8);
}

function printWallResults(results: WallResult[]): void {
  console.log("\n=== Wall-Time per Scan ===");
  console.log(
    `${"Fixture".padEnd(10)} ${"Files".padStart(6)} ${"p50 (ms)".padStart(10)} ${"p99 (ms)".padStart(10)} ${"min (ms)".padStart(10)} ${"max (ms)".padStart(10)}`,
  );
  console.log("-".repeat(60));
  for (const r of results) {
    console.log(
      `${r.label.padEnd(10)} ${String(r.fileCount).padStart(6)} ${fmt(r.p50Ms)} ${fmt(r.p99Ms)} ${fmt(r.minMs)} ${fmt(r.maxMs)}`,
    );
  }
}

function printELDResults(idle: ELDResult, load: ELDResult): void {
  console.log("\n=== Event-Loop Delay ===");
  console.log(`${"Condition".padEnd(42)} ${"p50 (ms)".padStart(10)} ${"p99 (ms)".padStart(10)}`);
  console.log("-".repeat(65));
  console.log(`${"Idle (no scans)".padEnd(42)} ${fmt(idle.p50Ms)} ${fmt(idle.p99Ms)}`);
  console.log(`${load.label.padEnd(42)} ${fmt(load.p50Ms)} ${fmt(load.p99Ms)}`);
  const deltaP50 = load.p50Ms - idle.p50Ms;
  const deltaP99 = load.p99Ms - idle.p99Ms;
  console.log(`${"Delta (load − idle)".padEnd(42)} ${fmt(deltaP50)} ${fmt(deltaP99)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Ghost Code — scanThemeFiles benchmark (GC-8uw)");
  console.log(`Iterations: ${WALL_TIME_ITERATIONS}  |  Concurrency: ${CONCURRENCY}`);
  console.log(`Fixtures: small=${SMALL_THEME.length} files, large=${LARGE_THEME.length} files`);

  // 1. Wall-time
  console.log("\nRunning wall-time measurements…");
  const wallSmall = measureWallTime("small", SMALL_THEME, WALL_TIME_ITERATIONS);
  const wallLarge = measureWallTime("large", LARGE_THEME, WALL_TIME_ITERATIONS);
  printWallResults([wallSmall, wallLarge]);

  // 2. Event-loop delay — idle baseline
  console.log("\nSampling idle event-loop delay…");
  const eldIdle = await measureIdleELD(IDLE_SAMPLE_MS);

  // 3. Event-loop delay — under load
  console.log(`Running ${CONCURRENCY} concurrent scans for event-loop delay measurement…`);
  const eldLoad = await measureLoadELD(LARGE_THEME, CONCURRENCY);

  printELDResults(eldIdle, eldLoad);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
