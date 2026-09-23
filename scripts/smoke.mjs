#!/usr/bin/env node
/**
 * Tier 3 post-deploy smoke test.
 *
 * Waits for the freshly-deployed service to boot (polls /health), then polls the
 * token-gated /health/deep ops endpoint until it reports EXPECTED_SHA (Railway
 * keeps routing to the old container briefly after the new one is up, gc-7y2),
 * then asserts every deep check is green on that SAME matched response, then
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
 *                      against body.deployedSha (hex, >= 7 chars). Polled until
 *                      it matches, then a mismatch FAILS the smoke (GC-59t,
 *                      blocking since GC-7ml). Unset (local/manual runs) logs a
 *                      ⚠ WARN only. A 401/403 fails at once (bad/missing token).
 *   SMOKE_SHA_TIMEOUT_MS   (optional) total wait for the SHA to match.
 *                          Default 240000 (4 min); capped at 30 min.
 *   SMOKE_SHA_INTERVAL_MS  (optional) delay between SHA polls. Default 10000;
 *                          capped at 30 min.
 */

import process from "node:process";

import {
  MAX_ENV_MS,
  evaluateDeepGate,
  parsePositiveIntEnv,
  toDeepReport,
  waitForShaMatch,
} from "./smoke-lib.mjs";

const BASE_URL = process.env.SMOKE_BASE_URL;
const HEALTH_CHECK_TOKEN = process.env.HEALTH_CHECK_TOKEN;
const EXPECTED_SHA = process.env.EXPECTED_SHA;

const BOOT_TIMEOUT_MS = 60_000;
const RETRY_INTERVAL_MS = 3_000;
const INNGEST_PROBE_RETRIES = 3;
const INNGEST_PROBE_TIMEOUT_MS = 10_000;
const SHA_TIMEOUT_MS = parsePositiveIntEnv(process.env.SMOKE_SHA_TIMEOUT_MS, 240_000, MAX_ENV_MS);
const SHA_INTERVAL_MS = parsePositiveIntEnv(process.env.SMOKE_SHA_INTERVAL_MS, 10_000, MAX_ENV_MS);
const SHA_REQUEST_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!BASE_URL) fail("SMOKE_BASE_URL is not set");

const base = BASE_URL.replace(/\/$/, "");
const deepHeaders = HEALTH_CHECK_TOKEN ? { "x-health-token": HEALTH_CHECK_TOKEN } : {};

// Non-blocking warnings, surfaced in the final summary line so a run with
// warnings is never reported as spotless.
let warnings = 0;
function warn(message) {
  warnings++;
  console.log(`⚠ WARN: ${message}`);
}

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

/**
 * One /health/deep request as a validated report. Throws a retryable Error on
 * network/non-JSON/no-deployedSha, and a PermanentSmokeError on 401/403.
 */
async function fetchDeepReport() {
  const res = await fetch(`${base}/health/deep`, {
    headers: deepHeaders,
    signal: AbortSignal.timeout(SHA_REQUEST_TIMEOUT_MS),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return toDeepReport(res.status, body, { tokenSet: Boolean(HEALTH_CHECK_TOKEN) });
}

/**
 * Get the /health/deep report to gate on. With EXPECTED_SHA set, poll until a
 * response reports it (gc-7y2): right after `railway up`, /health can already
 * be green while requests still reach the old container, so a one-shot read
 * false-fails a good deploy. The MATCHED response is returned and gated on
 * directly: a second request could land on the old container mid-swap and
 * false-fail the SHA pin. 401/403 fails at once (retrying cannot fix a token).
 */
async function getDeepReport() {
  if (!EXPECTED_SHA) {
    try {
      return await fetchDeepReport();
    } catch (error) {
      fail(
        `/health/deep request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(
    `Waiting up to ${SHA_TIMEOUT_MS / 1000}s for /health/deep to report ${EXPECTED_SHA}...`,
  );
  const result = await waitForShaMatch({
    expectedSha: EXPECTED_SHA,
    fetchReport: fetchDeepReport,
    timeoutMs: SHA_TIMEOUT_MS,
    intervalMs: SHA_INTERVAL_MS,
    onRetry: ({ attempt, lastSeen, lastError }) =>
      console.log(
        `  attempt ${attempt}: ${lastError ? `error (${lastError})` : `serving ${lastSeen ?? "null"}`}; retrying`,
      ),
  });
  if (result.ok) {
    console.log(`✓ deployed SHA ${result.sha} is serving (attempt ${result.attempts})`);
    return result.report;
  }
  if (result.permanent) fail(`/health/deep ${result.lastError}`);
  fail(
    `SHA pin mismatch after ${SHA_TIMEOUT_MS / 1000}s (${result.attempts} attempts) — expected ` +
      `${EXPECTED_SHA}, last seen ${result.lastSeen ?? "null"}` +
      (result.lastError ? ` (last error: ${result.lastError})` : ""),
  );
}

/**
 * Print the deep report and apply the gate to that same response. SHA pin
 * (GC-59t, BLOCKING since GC-7ml): a mismatch means the commit that triggered
 * this run is not what's serving traffic. Warn-only when EXPECTED_SHA is unset
 * (local/manual runs).
 */
function checkDeep(report) {
  const { httpStatus, body } = report;
  const checks = body.checks ?? {};
  console.log(`\nDeep health report (HTTP ${httpStatus}, status: ${body.status}):`);
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

  const gate = evaluateDeepGate(report, EXPECTED_SHA);
  if (!gate.ok) fail(gate.reason);
  console.log("\n✓ deep health checks green");
  if (gate.sha === "match") {
    console.log(`✓ deployed SHA matches (${gate.deployedSha})`);
  } else {
    warn(`SHA pin unverified — EXPECTED_SHA unset, deployed ${gate.deployedSha ?? "null"}`);
  }
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
  warn(
    `PUT /api/inngest did not confirm 200 after ${INNGEST_PROBE_RETRIES} attempts ` +
      `(last: ${lastError}). Not blocking — likely transient / Inngest-Cloud-dependent; ` +
      `a stale key would have returned 401 and blocked.`,
  );
}

// Every gate calls fail() (exit 1) on a blocking failure, so reaching the end
// means health, deployed SHA, deep health, and the Inngest probe all passed.
await waitForBoot();
checkDeep(await getDeepReport());
await probeInngestSigningKey();
console.log(
  warnings > 0
    ? `\n✓ All blocking post-deploy gates passed (${warnings} warning${warnings === 1 ? "" : "s"} above)`
    : "\n✓ All post-deploy gates passed",
);
process.exit(0);
