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
 */

import process from "node:process";

const BASE_URL = process.env.SMOKE_BASE_URL;
const HEALTH_CHECK_TOKEN = process.env.HEALTH_CHECK_TOKEN;

const BOOT_TIMEOUT_MS = 60_000;
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

async function checkDeep() {
  let res;
  try {
    res = await fetch(`${base}/health/deep`, {
      headers: HEALTH_CHECK_TOKEN ? { "x-health-token": HEALTH_CHECK_TOKEN } : {},
    });
  } catch (error) {
    fail(`/health/deep request failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    fail(`/health/deep returned non-JSON (HTTP ${res.status})`);
    return;
  }

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

  if (body.status === "ok" && res.status === 200) {
    console.log("\n✓ Smoke test passed — all checks green");
    process.exit(0);
  }

  fail(`Smoke test failed — status "${body.status}"${body.message ? `: ${body.message}` : ""}`);
}

await waitForBoot();
await checkDeep();
