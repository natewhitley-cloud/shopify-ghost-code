#!/usr/bin/env node
/**
 * Tier 3 post-deploy smoke test.
 *
 * Waits for the freshly-deployed service to boot (polls /health), then hits the
 * token-gated /health/deep ops endpoint and asserts every check is green.
 * Exits 0 only when status === "ok"; any degraded/error condition exits 1 so the
 * deploy workflow fails loudly.
 *
 * Dependency-free — uses global fetch (Node 18+).
 *
 * Env:
 *   SMOKE_BASE_URL     e.g. https://shopify-ghost-code-production.up.railway.app
 *   HEALTH_CHECK_TOKEN must match the app's HEALTH_CHECK_TOKEN env var
 *   EXPECTED_SHA       (optional) git commit SHA to wait for; when set, /health/deep
 *                      is polled until body.version matches AND status === "ok".
 *                      When unset, falls back to a one-shot deep check (local/manual
 *                      runs are backward compatible).
 */

import process from "node:process";

const BASE_URL = process.env.SMOKE_BASE_URL;
const HEALTH_CHECK_TOKEN = process.env.HEALTH_CHECK_TOKEN;
const EXPECTED_SHA = process.env.EXPECTED_SHA;

const BOOT_TIMEOUT_MS = 60_000;
const SHA_MATCH_TIMEOUT_MS = 90_000;
const RETRY_INTERVAL_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!BASE_URL) fail("SMOKE_BASE_URL is not set");

const base = BASE_URL.replace(/\/$/, "");

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) {
        console.log(`✓ /health returned 200 — service is up`);
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(RETRY_INTERVAL_MS);
  }
  fail(`/health did not return 200 within ${BOOT_TIMEOUT_MS / 1000}s (last: ${lastError})`);
}

/** Fetch /health/deep and parse JSON. Returns { res, body } or throws. */
async function fetchDeep() {
  const res = await fetch(`${base}/health/deep`, {
    headers: HEALTH_CHECK_TOKEN ? { "x-health-token": HEALTH_CHECK_TOKEN } : {},
  });
  const body = await res.json();
  return { res, body };
}

/** Print the per-check summary to stdout. */
function printDeepReport(res, body) {
  const checks = body.checks ?? {};
  console.log(`\nDeep health report (HTTP ${res.status}, status: ${body.status}):`);
  const mark = (ok) => (ok ? "✓" : "✗");
  console.log(`  ${mark(checks.db?.ok)} db: ${checks.db?.ok ? "reachable" : "UNREACHABLE"}`);
  console.log(
    `  ${mark(checks.inngest?.ok)} inngest: ${checks.inngest?.ok ? "keys present" : "KEYS MISSING"}`,
  );
  console.log(
    `  ${mark((checks.sessions?.expiredOffline ?? 0) === 0)} sessions: ${
      checks.sessions?.expiredOffline ?? "?"
    } expired offline`,
  );
  console.log(
    `  ${mark((checks.scans?.stuckPending ?? 0) === 0)} scans: ${
      checks.scans?.stuckPending ?? "?"
    } stuck PENDING`,
  );
}

/**
 * Prefix-tolerant SHA comparison — matches if either string is a prefix of the
 * other. Handles short-SHA vs full-SHA differences (e.g. github.sha is 40 chars,
 * Railway may report a shorter ref or vice versa).
 */
function shaMatches(a, b) {
  return a != null && b != null && (a.startsWith(b) || b.startsWith(a));
}

async function checkDeep() {
  if (EXPECTED_SHA) {
    // Poll until /health/deep reports the expected SHA — that signals the new build is live.
    // Health is evaluated separately once the SHA matches.
    const deadline = Date.now() + SHA_MATCH_TIMEOUT_MS;
    let lastVersion = null;
    while (Date.now() < deadline) {
      try {
        const { res, body } = await fetchDeep();
        lastVersion = body.version ?? null;
        if (shaMatches(body.version, EXPECTED_SHA)) {
          // New build is live — stop polling and evaluate health.
          printDeepReport(res, body);
          if (body.status === "ok" && res.status === 200) {
            console.log("\n✓ Smoke test passed — all checks green");
            process.exit(0);
          } else {
            fail(
              `Smoke test failed — status "${body.status}"${body.message ? `: ${body.message}` : ""}`,
            );
          }
        }
      } catch {
        // Network hiccup during rollover — keep retrying until deadline.
      }
      await sleep(RETRY_INTERVAL_MS);
    }
    fail(
      `app never reported expected SHA ${EXPECTED_SHA} within ${SHA_MATCH_TIMEOUT_MS / 1000}s — last seen: ${lastVersion}`,
    );
  } else {
    // Original one-shot behavior — backward compatible for local/manual runs.
    let res;
    try {
      let body;
      ({ res, body } = await fetchDeep());
      printDeepReport(res, body);
      if (body.status === "ok" && res.status === 200) {
        console.log("\n✓ Smoke test passed — all checks green");
        process.exit(0);
      }
      fail(`Smoke test failed — status "${body.status}"${body.message ? `: ${body.message}` : ""}`);
    } catch (error) {
      fail(
        `/health/deep request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

await waitForBoot();
await checkDeep();
