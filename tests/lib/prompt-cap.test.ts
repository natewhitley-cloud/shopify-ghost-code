/**
 * Tests for app/lib/prompt-cap.ts (gc-97k.6): the pure cross-prompt picker and
 * the claim predicate. Exhaustive on priority, the 24h window and its boundary.
 */
import { describe, it, expect } from "vitest";

import {
  pickPrompt,
  promptClaimNeeded,
  PROMPT_CAP_WINDOW_MS,
  PROMPT_KEYS,
} from "../../app/lib/prompt-cap";
import type { PromptKey } from "../../app/lib/prompt-cap";

const NOW = new Date("2026-09-26T12:00:00Z");
const MS = 1;
const HOUR = 60 * 60 * 1000;

/** A timestamp `ms` before NOW. */
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** No prompt ever shown. */
const FRESH = { lastPromptKey: null, lastPromptShownAt: null };

describe("PROMPT_KEYS / PROMPT_CAP_WINDOW_MS", () => {
  it("lists every interruptive prompt in the owner-approved priority order", () => {
    expect(PROMPT_KEYS).toEqual(["review_popup", "upgrade_return", "feedback", "review_banner"]);
  });

  it("is exactly 24 hours", () => {
    expect(PROMPT_CAP_WINDOW_MS).toBe(24 * HOUR);
  });
});

describe("pickPrompt: priority (no prompt shown yet)", () => {
  // Every ordered pair (higher, lower) from the priority list.
  const pairs: Array<[PromptKey, PromptKey]> = [];
  PROMPT_KEYS.forEach((higher, i) => {
    PROMPT_KEYS.slice(i + 1).forEach((lower) => pairs.push([higher, lower]));
  });

  it("covers all 6 priority pairs", () => {
    expect(pairs).toHaveLength(6);
  });

  it.each(pairs)("%s outranks %s, whatever order eligible lists them", (higher, lower) => {
    expect(pickPrompt({ ...FRESH, eligible: [higher, lower], now: NOW })).toBe(higher);
    expect(pickPrompt({ ...FRESH, eligible: [lower, higher], now: NOW })).toBe(higher);
  });

  it("all four eligible: review_popup", () => {
    expect(pickPrompt({ ...FRESH, eligible: [...PROMPT_KEYS].reverse(), now: NOW })).toBe(
      "review_popup",
    );
  });

  it.each(PROMPT_KEYS)("only %s eligible: that prompt", (key) => {
    expect(pickPrompt({ ...FRESH, eligible: [key], now: NOW })).toBe(key);
  });

  it("empty eligible list: null", () => {
    expect(pickPrompt({ ...FRESH, eligible: [], now: NOW })).toBeNull();
  });

  it("empty eligible list inside a window: null", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(HOUR),
        eligible: [],
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("pickPrompt: the 24h window", () => {
  it("the same prompt re-renders within 24h", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(23 * HOUR),
        eligible: ["feedback"],
        now: NOW,
      }),
    ).toBe("feedback");
  });

  it("the same prompt re-renders within 24h even when a higher-priority one is now eligible", () => {
    expect(
      pickPrompt({
        lastPromptKey: "review_banner",
        lastPromptShownAt: ago(HOUR),
        eligible: ["review_popup", "upgrade_return", "feedback", "review_banner"],
        now: NOW,
      }),
    ).toBe("review_banner");
  });

  it("a different prompt is blocked within 24h", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(HOUR),
        eligible: ["review_banner"],
        now: NOW,
      }),
    ).toBeNull();
  });

  it.each(PROMPT_KEYS)("a different prompt is blocked 1ms before 24h (last = %s)", (last) => {
    const others = PROMPT_KEYS.filter((k) => k !== last);
    expect(
      pickPrompt({
        lastPromptKey: last,
        lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS - MS),
        eligible: others,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("everything is allowed at exactly 24h (boundary): priority decides", () => {
    expect(
      pickPrompt({
        lastPromptKey: "review_banner",
        lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS),
        eligible: ["review_banner", "feedback"],
        now: NOW,
      }),
    ).toBe("feedback");
  });

  it("a different prompt is allowed at exactly 24h (boundary)", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS),
        eligible: ["review_banner"],
        now: NOW,
      }),
    ).toBe("review_banner");
  });

  it("a different prompt is allowed after 24h", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(3 * PROMPT_CAP_WINDOW_MS),
        eligible: ["review_banner"],
        now: NOW,
      }),
    ).toBe("review_banner");
  });

  it("the last prompt no longer eligible (dismissed) within 24h: null, not the next prompt", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(2 * HOUR),
        eligible: ["review_banner", "upgrade_return"],
        now: NOW,
      }),
    ).toBeNull();
  });

  it("an unknown (retired) lastPromptKey within 24h still blocks every prompt", () => {
    expect(
      pickPrompt({
        lastPromptKey: "some_retired_prompt",
        lastPromptShownAt: ago(HOUR),
        eligible: [...PROMPT_KEYS],
        now: NOW,
      }),
    ).toBeNull();
  });

  it("a null lastPromptShownAt means no open window (key alone does not block)", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: null,
        eligible: ["review_banner"],
        now: NOW,
      }),
    ).toBe("review_banner");
  });

  it("a null lastPromptKey means no open window (timestamp alone does not block)", () => {
    expect(
      pickPrompt({
        lastPromptKey: null,
        lastPromptShownAt: ago(HOUR),
        eligible: ["review_banner"],
        now: NOW,
      }),
    ).toBe("review_banner");
  });

  it("a lastPromptShownAt in the future (clock skew) counts as inside the window", () => {
    expect(
      pickPrompt({
        lastPromptKey: "feedback",
        lastPromptShownAt: new Date(NOW.getTime() + HOUR),
        eligible: ["review_banner"],
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("promptClaimNeeded", () => {
  it("true when nothing has been shown yet", () => {
    expect(promptClaimNeeded("feedback", FRESH, NOW)).toBe(true);
  });

  it("false for the same prompt re-rendering inside its window (window not extended)", () => {
    expect(
      promptClaimNeeded(
        "feedback",
        { lastPromptKey: "feedback", lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS - MS) },
        NOW,
      ),
    ).toBe(false);
  });

  it("true for the same prompt once the window has expired (exactly 24h)", () => {
    expect(
      promptClaimNeeded(
        "feedback",
        { lastPromptKey: "feedback", lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS) },
        NOW,
      ),
    ).toBe(true);
  });

  it("true for a different prompt than the recorded one", () => {
    expect(
      promptClaimNeeded(
        "review_banner",
        { lastPromptKey: "feedback", lastPromptShownAt: ago(2 * PROMPT_CAP_WINDOW_MS) },
        NOW,
      ),
    ).toBe(true);
  });

  it("true when the key matches but the timestamp is missing", () => {
    expect(
      promptClaimNeeded("feedback", { lastPromptKey: "feedback", lastPromptShownAt: null }, NOW),
    ).toBe(true);
  });
});
