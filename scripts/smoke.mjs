#!/usr/bin/env node
/**
 * Tier 3 post-deploy smoke test.
 *
 * Waits for the freshly-deployed service to boot (polls /health), then hits the
 * token-gated /health/deep ops endpoint and asserts every check is green, then
 * probes PUT /api/inngest to verify the Inngest signing key is not just present
 * but VALID (the cold-start-safe health check and the "keys present" deep check
 * both pass on a stale-but-present key — gc-06e.18).
 * Exits 0 only when every gate passes; any degraded/error condition exits 1 so
 * the deploy workflow fails loudly.
 *
 * Dependency-free — uses global fetch (Node 18+).
 *
 * Env:
 *   SMOKE_BASE_URL     e.g. https://shopify-ghost-code-production.up.railway.app
 *   HEALTH_CHECK_TOKEN must match the app's HEALTH_CHECK_TOKEN env var
 *   EXPECTED_SHA       (optional) git commit SHA injected by CI; compared
 *                      against body.deployedSha after a passing health check.
 *                      Mismatches FAIL the smoke (GC-59t, blocking since
 *                      GC-7ml). Unset (local/manual runs) logs a ⚠ WARN only.
 */

import process from "node:process";

const BASE_URL = process.env.SMOKE_BASE_URL;
const HEALTH_CHECK_TOKEN = process.env.HEALTH_CHECK_TOKEN;
const EXPECTED_SHA = process.env.EXPECTED_SHA;

const BOOT_TIMEOUT_MS = 60_000;
const RETRY_INTERVAL_MS = 3_000;
const INNGEST_PROBE_RETRIES = 3;
const INNGEST_PROBE_TIMEOUT_MS = 10_000;

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

    // SHA pin check (GC-59t, BLOCKING since GC-7ml): a mismatch means the
    // commit that triggered this run is not what's serving traffic — fail the
    // gate. Stays warn-only when EXPECTED_SHA is unset (local/manual runs).
    const deployedSha = body.deployedSha ?? null;
    const shaVerified =
      Boolean(EXPECTED_SHA) &&
      Boolean(deployedSha) &&
      (EXPECTED_SHA.startsWith(deployedSha) || deployedSha.startsWith(EXPECTED_SHA));
    if (shaVerified) {
      console.log(`✓ deployed SHA matches (${deployedSha})`);
    } else if (EXPECTED_SHA) {
      fail(`SHA pin mismatch — expected ${EXPECTED_SHA}, got ${deployedSha ?? "null"}`);
    } else {
      console.log(
        `⚠ WARN: SHA pin unverified — EXPECTED_SHA unset, deployed ${deployedSha ?? "null"}`,
      );
    }

    return; // deep check green — control returns to run the inngest probe
  }

  fail(`Smoke test failed — status "${body.status}"${body.message ? `: ${body.message}` : ""}`);
}

/**
 * Authoritative Inngest signing-key probe (gc-06e.18).
 *
 * /health/deep only asserts the key is PRESENT, and the dead-man's-switch is
 * cold-start-safe (never-seen crons are not flagged), so a stale-but-present
 * INNGEST_SIGNING_KEY passes both at the smoke-gate instant — then every cron
 * silently stops. PUT /api/inngest makes the server sync with Inngest Cloud
 * using that key: 200 = valid, 401 = stale/invalid.
 *
 * A 401 is definitive (bad key) and BLOCKS the deploy. But PUT /api/inngest makes
 * the app re-sync with Inngest Cloud, so its result also depends on Inngest Cloud's
 * availability/latency at this instant — a transient 5xx/timeout is NOT proof of a
 * bad deploy. So non-401 failures WARN-only (do not block) until this probe has
 * proven stable across real deploys (deploy-safety: soft-launch an assertion before
 * making it a blocking gate). Each attempt is time-bounded so a hung connection to
 * Inngest Cloud can never stall the deploy job.
 */
async function probeInngestSigningKey() {
  let lastError = "no response";
  for (let attempt = 1; attempt <= INNGEST_PROBE_RETRIES; attempt++) {
    try {
      const res = await fetch(`${base}/api/inngest`, {
        method: "PUT",
        signal: AbortSignal.timeout(INNGEST_PROBE_TIMEOUT_MS),
      });
      if (res.status === 200) {
        console.log("✓ PUT /api/inngest returned 200 — Inngest signing key is valid");
        return;
      }
      lastError = `HTTP ${res.status}`;
      if (res.status === 401) {
        fail(
          "PUT /api/inngest returned 401 — INNGEST_SIGNING_KEY is stale/invalid; crons will silently stop",
        );
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < INNGEST_PROBE_RETRIES) await sleep(RETRY_INTERVAL_MS);
  }
  // Non-401 failure (transient 5xx, timeout, network). Warn but do NOT block —
  // a 401 above is the only signal we treat as a definitive stale key.
  console.log(
    `⚠ WARN: PUT /api/inngest did not confirm 200 after ${INNGEST_PROBE_RETRIES} attempts ` +
      `(last: ${lastError}). Not blocking — likely transient / Inngest-Cloud-dependent; ` +
      `a stale key would have returned 401 and blocked.`,
  );
}

await waitForBoot();
await checkDeep();
await probeInngestSigningKey();
console.log("\n✓ All post-deploy gates passed");
process.exit(0);
