/**
 * Tests for app/lib/scan-progress.ts: the scan wait experience's rotating
 * phrase, copy guards, findings-so-far line, and elapsed-time helpers.
 */
import { describe, it, expect } from "vitest";

import {
  findingsSoFarLabel,
  formatElapsedTime,
  LONG_SCAN_AFTER_SECONDS,
  LONG_SCAN_PHRASES,
  SCAN_DURATION_EXPECTATION,
  SCAN_PHRASE_INTERVAL_SECONDS,
  SCAN_PHRASES,
  scanElapsedSeconds,
  scanProgressPhrase,
} from "../../app/lib/scan-progress";

const I = SCAN_PHRASE_INTERVAL_SECONDS;
const LONG = new Set(LONG_SCAN_PHRASES);

describe("scanProgressPhrase", () => {
  it("rotates every 7 seconds, starting at the first phrase", () => {
    expect(I).toBe(7);
    expect(scanProgressPhrase(0)).toBe(SCAN_PHRASES[0]);
    expect(scanProgressPhrase(6.999)).toBe(SCAN_PHRASES[0]);
    expect(scanProgressPhrase(7)).toBe(SCAN_PHRASES[1]);
    expect(scanProgressPhrase(13.9)).toBe(SCAN_PHRASES[1]);
    expect(scanProgressPhrase(14)).toBe(SCAN_PHRASES[2]);
  });

  it("is deterministic for a given elapsed time (survives revalidation re-renders)", () => {
    for (const t of [0, 3, 7, 42.5, 61, 63, 300, 3600]) {
      expect(scanProgressPhrase(t)).toBe(scanProgressPhrase(t));
    }
    // Two renders inside the same 7s slot (e.g. 3s polls) show the same phrase.
    expect(scanProgressPhrase(21)).toBe(scanProgressPhrase(23.9));
  });

  it("never shows a long-scan phrase at or before 60 seconds", () => {
    expect(LONG_SCAN_AFTER_SECONDS).toBe(60);
    for (let t = 0; t <= LONG_SCAN_AFTER_SECONDS; t += 0.5) {
      expect(LONG.has(scanProgressPhrase(t))).toBe(false);
    }
  });

  it("starts the long-scan set at the first slot past 60 seconds", () => {
    // Slots start every 7s: 56 (still base), then 63, the first slot >= 60s.
    expect(scanProgressPhrase(62.9)).toBe(SCAN_PHRASES[8]);
    expect(scanProgressPhrase(63)).toBe(LONG_SCAN_PHRASES[0]);
  });

  it("shows every long-scan phrase once a scan runs long", () => {
    const seen = new Set<string>();
    for (let t = 0; t < 600; t += I) seen.add(scanProgressPhrase(t));
    for (const p of LONG_SCAN_PHRASES) expect(seen.has(p)).toBe(true);
    for (const p of SCAN_PHRASES) expect(seen.has(p)).toBe(true);
  });

  it("never shows the same phrase twice in a row, including across wraps", () => {
    // 2,000 slots is ~4 hours: many full wraps of both lists.
    for (let slot = 1; slot < 2000; slot++) {
      expect(scanProgressPhrase(slot * I)).not.toBe(scanProgressPhrase((slot - 1) * I));
    }
  });

  it("treats a negative or non-finite elapsed time as the start", () => {
    expect(scanProgressPhrase(-30)).toBe(SCAN_PHRASES[0]);
    expect(scanProgressPhrase(Number.NaN)).toBe(SCAN_PHRASES[0]);
    expect(scanProgressPhrase(Number.POSITIVE_INFINITY)).toBe(SCAN_PHRASES[0]);
  });
});

describe("scan wait copy guards", () => {
  const ALL = [...SCAN_PHRASES, ...LONG_SCAN_PHRASES];

  it("has 12-16 general phrases and 2-3 long-scan phrases, all distinct", () => {
    expect(SCAN_PHRASES.length).toBeGreaterThanOrEqual(12);
    expect(SCAN_PHRASES.length).toBeLessThanOrEqual(16);
    expect(LONG_SCAN_PHRASES.length).toBeGreaterThanOrEqual(2);
    expect(LONG_SCAN_PHRASES.length).toBeLessThanOrEqual(3);
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it.each(ALL)("'%s' is short, sentence case, with no trailing punctuation", (p) => {
    expect(p.length).toBeLessThanOrEqual(60);
    expect(p[0]).toBe(p[0].toUpperCase());
    expect(p).not.toMatch(/[.!?…]$/);
  });

  it.each([...ALL, SCAN_DURATION_EXPECTATION])("'%s' has no em or en dash", (p) => {
    expect(p).not.toMatch(/[—–]/);
  });

  it.each([...ALL, SCAN_DURATION_EXPECTATION])(
    "'%s' never tells the merchant to leave or come back",
    (p) => {
      expect(p).not.toMatch(/\b(come back|leave|leaving|later|e-?mail|notify)\b/i);
    },
  );

  it.each(ALL)("'%s' never implies findings exist", (p) => {
    expect(p).not.toMatch(/\b(found|finding|findings|issues?|problems?)\b/i);
  });

  it("sets the up-to-a-minute-or-two expectation", () => {
    expect(SCAN_DURATION_EXPECTATION).toMatch(/^This usually takes up to a minute or two\./);
  });
});

// findingsSoFarLabel: the live findings count (gc-rzq), moved from the scan
// page. Rules: never "Found 0" (reads like a completed empty scan), singular vs
// plural, and always in-progress ("so far…"), never a final-sounding count.
describe("findingsSoFarLabel", () => {
  it("is null for 0 or a negative count (the rotating phrase covers it)", () => {
    expect(findingsSoFarLabel(0)).toBeNull();
    expect(findingsSoFarLabel(-1)).toBeNull();
  });

  it("uses the singular 'finding' for exactly one", () => {
    expect(findingsSoFarLabel(1)).toBe("Found 1 finding so far…");
  });

  it("uses the plural 'findings' for more than one", () => {
    expect(findingsSoFarLabel(2)).toBe("Found 2 findings so far…");
    expect(findingsSoFarLabel(45)).toBe("Found 45 findings so far…");
  });

  it("always reads as in-progress, never final", () => {
    for (const n of [1, 2, 45, 200]) expect(findingsSoFarLabel(n)).toMatch(/so far…$/);
  });
});

describe("scanElapsedSeconds", () => {
  const created = new Date("2026-10-08T10:00:00Z");

  it("measures from createdAt (Date or ISO string)", () => {
    const now = created.getTime() + 42_000;
    expect(scanElapsedSeconds(created, now)).toBe(42);
    expect(scanElapsedSeconds(created.toISOString(), now)).toBe(42);
  });

  it("clamps to 0 when the client clock is behind the server", () => {
    expect(scanElapsedSeconds(created, created.getTime() - 5_000)).toBe(0);
  });

  it("is 0 for an unparseable date", () => {
    expect(scanElapsedSeconds("not a date", Date.now())).toBe(0);
  });
});

describe("formatElapsedTime", () => {
  it.each([
    [0, "a few seconds"],
    [9.9, "a few seconds"],
    [10, "10 seconds"],
    [59.9, "59 seconds"],
    [60, "1 minute"],
    [75, "1 minute 15 seconds"],
    [120, "2 minutes"],
    [195, "3 minutes 15 seconds"],
  ])("%s seconds -> %s", (seconds, expected) => {
    expect(formatElapsedTime(seconds)).toBe(expected);
  });
});
