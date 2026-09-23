/**
 * Unit tests for the post-deploy smoke helpers (gc-7y2).
 *
 * waitForShaMatch polls the deployed SHA until it matches EXPECTED_SHA so a
 * Railway container swap (old container still answering for a short while)
 * does not false-fail the SHA-pin gate. Time and sleep are injected, so these
 * tests run instantly and deterministically.
 */

import { describe, it, expect, vi } from "vitest";

import { parsePositiveIntEnv, shaMatches, waitForShaMatch } from "../../scripts/smoke-lib.mjs";

const NEW_SHA = "abc1234def5678";
const OLD_SHA = "0000000ffff1111";

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
});

describe("waitForShaMatch", () => {
  it("succeeds on the first attempt without sleeping when the SHA already matches", async () => {
    const clock = fakeClock();
    const fetchSha = vi.fn(async () => NEW_SHA);

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 60_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toEqual({ ok: true, sha: NEW_SHA, attempts: 1 });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("keeps polling through the container swap and succeeds once the new SHA serves", async () => {
    const clock = fakeClock();
    const responses = [OLD_SHA, OLD_SHA, NEW_SHA];
    const fetchSha = vi.fn(async () => responses.shift() ?? null);
    const onRetry = vi.fn();

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 60_000,
      intervalMs: 10_000,
      onRetry,
      ...clock,
    });

    expect(result).toEqual({ ok: true, sha: NEW_SHA, attempts: 3 });
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledWith(10_000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, lastSeen: OLD_SHA, lastError: null });
  });

  it("retries through network errors and succeeds when the endpoint recovers", async () => {
    const clock = fakeClock();
    const fetchSha = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(NEW_SHA);

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 60_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toEqual({ ok: true, sha: NEW_SHA, attempts: 3 });
  });

  it("times out with the last-seen SHA when the new container never serves", async () => {
    const clock = fakeClock();
    const fetchSha = vi.fn(async () => OLD_SHA);

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 30_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toEqual({ ok: false, lastSeen: OLD_SHA, lastError: null, attempts: 4 });
    // Bounded: total simulated wait never exceeds the timeout.
    expect(clock.now()).toBe(30_000);
  });

  it("reports the last error on timeout when every attempt failed", async () => {
    const clock = fakeClock();
    const fetchSha = vi.fn(async (): Promise<string | null> => {
      throw new Error("HTTP 401: unauthorized");
    });

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 20_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ lastSeen: null, lastError: "HTTP 401: unauthorized" });
  });

  it("keeps the last SEEN SHA when a later attempt errors", async () => {
    const clock = fakeClock();
    const fetchSha = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(OLD_SHA)
      .mockRejectedValue(new Error("timeout"));

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 20_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, lastSeen: OLD_SHA, lastError: "timeout" });
  });

  it("never sleeps past the deadline when the interval does not divide the timeout", async () => {
    const clock = fakeClock();
    const fetchSha = vi.fn(async () => OLD_SHA);

    await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 25_000,
      intervalMs: 10_000,
      ...clock,
    });

    expect(clock.sleep).toHaveBeenLastCalledWith(5_000);
    expect(clock.now()).toBe(25_000);
  });

  it("makes exactly one attempt when the timeout is zero", async () => {
    const clock = fakeClock();
    const fetchSha = vi.fn(async () => OLD_SHA);

    const result = await waitForShaMatch({
      expectedSha: NEW_SHA,
      fetchSha,
      timeoutMs: 0,
      intervalMs: 10_000,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(clock.sleep).not.toHaveBeenCalled();
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
});
