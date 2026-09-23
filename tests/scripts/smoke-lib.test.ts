/**
 * Unit tests for the post-deploy smoke helpers (gc-7y2).
 *
 * waitForShaMatch polls the deployed SHA until it matches EXPECTED_SHA so a
 * Railway container swap (old container still answering for a short while)
 * does not false-fail the SHA-pin gate. Time and sleep are injected, so these
 * tests run instantly and deterministically.
 */

import { describe, it, expect, vi } from "vitest";

import {
  MAX_ENV_MS,
  PermanentSmokeError,
  evaluateDeepGate,
  parsePositiveIntEnv,
  shaMatches,
  toDeepReport,
  waitForShaMatch,
} from "../../scripts/smoke-lib.mjs";

const NEW_SHA = "abc1234def5678";
const OLD_SHA = "0000000ffff1111";

/** A 200 /health/deep report whose body carries `sha`. */
function report(sha: string | null, httpStatus = 200) {
  return {
    httpStatus,
    body: {
      status: "ok",
      deployedSha: sha,
      checks: {
        db: { ok: true },
        inngest: { ok: true },
        sessions: { expiredOffline: 0 },
        scans: { stuckPending: 0 },
      },
    },
  };
}

/** Fake clock: sleep advances `now` instead of waiting. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe("shaMatches", () => {
  it("matches identical SHAs", () => {
    expect(shaMatches(NEW_SHA, NEW_SHA)).toBe(true);
  });

  it("matches a short SHA against a full SHA in either direction", () => {
    expect(shaMatches(NEW_SHA, "abc1234")).toBe(true);
    expect(shaMatches("abc1234", NEW_SHA)).toBe(true);
  });

  it("rejects a different SHA", () => {
    expect(shaMatches(NEW_SHA, OLD_SHA)).toBe(false);
  });

  it("rejects a missing expected or deployed SHA", () => {
    expect(shaMatches(NEW_SHA, null)).toBe(false);
    expect(shaMatches(NEW_SHA, "")).toBe(false);
    expect(shaMatches("", NEW_SHA)).toBe(false);
    expect(shaMatches(undefined, NEW_SHA)).toBe(false);
  });

  it("rejects a deployed SHA shorter than 7 characters even when it is a prefix", () => {
    expect(shaMatches(NEW_SHA, "a")).toBe(false);
    expect(shaMatches(NEW_SHA, "abc123")).toBe(false);
    expect(shaMatches("abc123", NEW_SHA)).toBe(false);
    expect(shaMatches(NEW_SHA, "abc1234")).toBe(true);
  });

  it("rejects non-hex or non-string SHAs", () => {
    expect(shaMatches("abc1234", "abc1234g")).toBe(false);
    expect(shaMatches("unknown", "unknown")).toBe(false);
    expect(shaMatches(NEW_SHA, 12345 as unknown as string)).toBe(false);
  });

  it("accepts uppercase hex SHAs", () => {
    expect(shaMatches("ABC1234DEF", "ABC1234")).toBe(true);
  });
});

describe("waitForShaMatch", () => {
  it("succeeds on the first attempt without sleeping when the SHA already matches", async () => {
    const clock = fakeClock();
    const matched = report(NEW_SHA);
    const fetchReport = vi.fn(async () => matched);

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 60_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toEqual({ ok: true, sha: NEW_SHA, report: matched, attempts: 1 });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("keeps polling through the container swap and succeeds once the new SHA serves", async () => {
    const clock = fakeClock();
    const responses = [report(OLD_SHA), report(OLD_SHA), report(NEW_SHA)];
    const fetchReport = vi.fn(async () => responses.shift() ?? report(null));
    const onRetry = vi.fn();

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 60_000,
      intervalMs: 10_000,
      onRetry,
      ...clock,
    });

    expect(result).toMatchObject({ ok: true, sha: NEW_SHA, attempts: 3 });
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledWith(10_000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, lastSeen: OLD_SHA, lastError: null });
  });

  it("returns the exact response that matched so the gate cannot re-hit an old container (flap)", async () => {
    // Load balancer splitting old/new: every other response is the old container.
    const clock = fakeClock();
    let n = 0;
    const fetchReport = vi.fn(async () => {
      n++;
      return n % 2 === 0 ? report(NEW_SHA) : report(OLD_SHA);
    });

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 60_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.report.body.deployedSha).toBe(NEW_SHA);
    // Gate evaluated on the matched response passes; no second request made.
    expect(evaluateDeepGate(result.report, NEW_SHA)).toMatchObject({ ok: true, sha: "match" });
    expect(fetchReport).toHaveBeenCalledTimes(2);
  });

  it("retries through network errors and succeeds when the endpoint recovers", async () => {
    const clock = fakeClock();
    const fetchReport = vi
      .fn<() => Promise<ReturnType<typeof report>>>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(report(NEW_SHA));

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 60_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toMatchObject({ ok: true, sha: NEW_SHA, attempts: 3 });
  });

  it("stops immediately on a permanent error (unauthorized) without sleeping", async () => {
    const clock = fakeClock();
    const fetchReport = vi.fn(async (): Promise<ReturnType<typeof report>> => {
      throw new PermanentSmokeError("unauthorized (HTTP 401): check HEALTH_CHECK_TOKEN");
    });

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 240_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toEqual({
      ok: false,
      permanent: true,
      lastSeen: null,
      lastError: "unauthorized (HTTP 401): check HEALTH_CHECK_TOKEN",
      attempts: 1,
    });
    expect(fetchReport).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("times out with the last-seen SHA when the new container never serves", async () => {
    const clock = fakeClock();
    const fetchReport = vi.fn(async () => report(OLD_SHA));

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 30_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toEqual({
      ok: false,
      permanent: false,
      lastSeen: OLD_SHA,
      lastError: null,
      attempts: 4,
    });
    // Bounded: total simulated wait never exceeds the timeout.
    expect(clock.now()).toBe(30_000);
  });

  it("never matches a too-short deployed SHA and times out (shortsha)", async () => {
    const clock = fakeClock();
    const fetchReport = vi.fn(async () => report("a"));

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 20_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, lastSeen: "a" });
  });

  it("reports the last error on timeout when every attempt failed transiently", async () => {
    const clock = fakeClock();
    const fetchReport = vi.fn(async (): Promise<ReturnType<typeof report>> => {
      throw new Error("HTTP 502");
    });

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 20_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toMatchObject({
      ok: false,
      permanent: false,
      lastSeen: null,
      lastError: "HTTP 502",
    });
  });

  it("keeps the last SEEN SHA when a later attempt errors", async () => {
    const clock = fakeClock();
    const fetchReport = vi
      .fn<() => Promise<ReturnType<typeof report>>>()
      .mockResolvedValueOnce(report(OLD_SHA))
      .mockRejectedValue(new Error("timeout"));

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 20_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, lastSeen: OLD_SHA, lastError: "timeout" });
  });

  it("never sleeps past the deadline when the interval does not divide the timeout", async () => {
    const clock = fakeClock();
    const fetchReport = vi.fn(async () => report(OLD_SHA));

    await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 25_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(clock.sleep).toHaveBeenLastCalledWith(5_000);
    expect(clock.now()).toBe(25_000);
  });

  it("makes exactly one attempt when the timeout is zero", async () => {
    const clock = fakeClock();
    const fetchReport = vi.fn(async () => report(OLD_SHA));

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchReport,
      timeoutMs: 0,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(clock.sleep).not.toHaveBeenCalled();
  });
});

describe("toDeepReport", () => {
  it("returns the status and body for a JSON response carrying deployedSha", () => {
    const { body } = report(NEW_SHA);
    expect(toDeepReport(200, body, { tokenSet: true })).toEqual({ httpStatus: 200, body });
  });

  it("keeps a degraded (503) body so the gate can report it", () => {
    const body = { status: "degraded", deployedSha: NEW_SHA, checks: {} };
    expect(toDeepReport(503, body, { tokenSet: true })).toEqual({ httpStatus: 503, body });
  });

  it.each([401, 403])("throws a PERMANENT unauthorized error on HTTP %i", (status) => {
    const call = () =>
      toDeepReport(status, { status: "error", message: "unauthorized" }, { tokenSet: true });
    expect(call).toThrow(PermanentSmokeError);
    expect(call).toThrow(`unauthorized (HTTP ${status}): check HEALTH_CHECK_TOKEN`);
  });

  it("says the token is not set when unauthorized without a token", () => {
    expect(() => toDeepReport(401, undefined, { tokenSet: false })).toThrow(
      "unauthorized (HTTP 401): check HEALTH_CHECK_TOKEN (not set)",
    );
  });

  it("throws a retryable error for a non-JSON or null body", () => {
    for (const body of [undefined, null]) {
      let caught: unknown;
      try {
        toDeepReport(200, body, { tokenSet: true });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(PermanentSmokeError);
      expect((caught as Error).message).toBe("non-JSON response (HTTP 200)");
    }
  });

  it("throws a retryable error when the body has no deployedSha", () => {
    const call = () => toDeepReport(500, { status: "error", message: "boom" }, { tokenSet: true });
    expect(call).toThrow("HTTP 500: boom");
    try {
      call();
    } catch (error) {
      expect(error).not.toBeInstanceOf(PermanentSmokeError);
    }
  });
});

describe("evaluateDeepGate", () => {
  it("passes an ok/200 report whose SHA matches", () => {
    expect(evaluateDeepGate(report(NEW_SHA), NEW_SHA)).toEqual({
      ok: true,
      sha: "match",
      deployedSha: NEW_SHA,
    });
  });

  it("fails a degraded report even when the SHA matches", () => {
    const degraded = {
      httpStatus: 503,
      body: { status: "degraded", message: "db down", deployedSha: NEW_SHA, checks: {} },
    };
    expect(evaluateDeepGate(degraded, NEW_SHA)).toEqual({
      ok: false,
      reason: 'Smoke test failed — status "degraded": db down',
    });
  });

  it("fails an ok body served with a non-200 status", () => {
    expect(evaluateDeepGate(report(NEW_SHA, 500), NEW_SHA)).toMatchObject({ ok: false });
  });

  it("fails a SHA mismatch when EXPECTED_SHA is set", () => {
    expect(evaluateDeepGate(report(OLD_SHA), NEW_SHA)).toEqual({
      ok: false,
      reason: `SHA pin mismatch — expected ${NEW_SHA}, got ${OLD_SHA}`,
    });
  });

  it("fails a too-short deployed SHA when EXPECTED_SHA is set", () => {
    expect(evaluateDeepGate(report("a"), NEW_SHA)).toMatchObject({ ok: false });
  });

  it("passes but flags the SHA unverified when EXPECTED_SHA is unset", () => {
    expect(evaluateDeepGate(report(OLD_SHA), undefined)).toEqual({
      ok: true,
      sha: "unverified",
      deployedSha: OLD_SHA,
    });
  });
});

describe("parsePositiveIntEnv", () => {
  it("returns the default when unset or empty", () => {
    expect(parsePositiveIntEnv(undefined, 240_000)).toBe(240_000);
    expect(parsePositiveIntEnv("", 240_000)).toBe(240_000);
  });

  it("parses a positive integer", () => {
    expect(parsePositiveIntEnv("300000", 240_000)).toBe(300_000);
  });

  it("falls back to the default for zero, negative, fractional, or non-numeric input", () => {
    expect(parsePositiveIntEnv("0", 10_000)).toBe(10_000);
    expect(parsePositiveIntEnv("-5", 10_000)).toBe(10_000);
    expect(parsePositiveIntEnv("1.5", 10_000)).toBe(10_000);
    expect(parsePositiveIntEnv("ten", 10_000)).toBe(10_000);
    expect(parsePositiveIntEnv("10s", 10_000)).toBe(10_000);
  });

  it("clamps values above the max (setTimeout overflows past 2^31-1 ms)", () => {
    expect(MAX_ENV_MS).toBe(30 * 60_000);
    expect(parsePositiveIntEnv("99999999999", 10_000, MAX_ENV_MS)).toBe(MAX_ENV_MS);
    expect(parsePositiveIntEnv("9".repeat(400), 10_000, MAX_ENV_MS)).toBe(MAX_ENV_MS);
    expect(parsePositiveIntEnv(String(MAX_ENV_MS), 10_000, MAX_ENV_MS)).toBe(MAX_ENV_MS);
    expect(parsePositiveIntEnv("60000", 10_000, MAX_ENV_MS)).toBe(60_000);
  });
});
