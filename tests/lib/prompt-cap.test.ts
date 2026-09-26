/**
 * Tests for app/lib/prompt-cap.ts (gc-97k.6): the pure cross-prompt picker, the
 * page-renderability table and the claim predicate. Exhaustive on priority,
 * the 24h window and its boundary, and page renderability.
 *
 * Owner decision 1A (strict GLOBAL priority) changed two behaviors the earlier
 * tests pinned, on purpose:
 *   - The window holder no longer re-renders once a HIGHER-priority prompt is
 *     eligible: the top prompt is pending, so nothing renders until the window
 *     passes (was: the holder kept re-rendering).
 *   - A page renders nothing (and claims nothing) when it cannot render the
 *     shop's top prompt; a lower prompt it could render no longer steps in.
 * Owner decision 2A retired `review_banner`, so PROMPT_KEYS has three keys.
 */
import { describe, it, expect } from "vitest";

import {
  HOME_DEFERRED_PROMPTS,
  HOME_PROMPTS,
  isStillBlocking,
  pagePendingPrompt,
  pickPrompt,
  promptClaimNeeded,
  PROMPT_BLOCK_MAX_MS,
  PROMPT_CAP_WINDOW_MS,
  PROMPT_KEYS,
  scanResultsDeferredPrompts,
  scanResultsPrompts,
} from "../../app/lib/prompt-cap";
import type { PickPromptInput, PromptKey } from "../../app/lib/prompt-cap";
import { REVIEW_POPUP_MIN_SCAN_AGE_MS } from "../../app/lib/review-request";

const NOW = new Date("2026-09-26T12:00:00Z");
const MS = 1;
const HOUR = 60 * 60 * 1000;

/** A timestamp `ms` before NOW. */
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY_MS = 24 * HOUR;

/** No prompt ever shown. */
const FRESH = { lastPromptKey: null, lastPromptShownAt: null };

/** A page that can render every prompt, so only priority and the window decide. */
const ALL = PROMPT_KEYS;

/** Defaults: renders everything, and no eligibleSince (prompts never stop blocking). */
function pick(overrides: Partial<PickPromptInput> & Pick<PickPromptInput, "eligible">) {
  return pickPrompt({
    ...FRESH,
    renderable: ALL,
    deferred: [],
    eligibleSince: {},
    now: NOW,
    ...overrides,
  });
}

describe("PROMPT_KEYS / PROMPT_CAP_WINDOW_MS", () => {
  it("lists every interruptive prompt in the owner-approved priority order (no review_banner)", () => {
    expect(PROMPT_KEYS).toEqual(["review_popup", "upgrade_return", "feedback"]);
  });

  it("is exactly 24 hours", () => {
    expect(PROMPT_CAP_WINDOW_MS).toBe(24 * HOUR);
  });
});

describe("page renderability", () => {
  it("Home renders only the feedback nudge", () => {
    expect(HOME_PROMPTS).toEqual(["feedback"]);
  });

  it("a successful Free scan with hidden findings renders the popup and the return banner", () => {
    expect(
      scanResultsPrompts({
        scanCompletedAt: ago(DAY_MS),
        now: NOW,
        scanSuccessful: true,
        plan: "free",
        hasHiddenFindings: true,
      }),
    ).toEqual(["review_popup", "upgrade_return"]);
  });

  it("a successful Free scan with nothing hidden renders only the popup", () => {
    expect(
      scanResultsPrompts({
        scanCompletedAt: ago(DAY_MS),
        now: NOW,
        scanSuccessful: true,
        plan: "free",
        hasHiddenFindings: false,
      }),
    ).toEqual(["review_popup"]);
  });

  it.each(["Standard", "Professional"])(
    "a successful %s scan renders only the popup (return banner is Free only)",
    (plan) => {
      expect(
        scanResultsPrompts({
          scanCompletedAt: ago(DAY_MS),
          now: NOW,
          scanSuccessful: true,
          plan,
          hasHiddenFindings: true,
        }),
      ).toEqual(["review_popup"]);
    },
  );

  it.each([
    ["free", true],
    ["free", false],
    ["Standard", true],
  ])("an unsuccessful scan renders nothing (plan %s, hidden %s)", (plan, hasHiddenFindings) => {
    expect(
      scanResultsPrompts({
        scanCompletedAt: ago(DAY_MS),
        now: NOW,
        scanSuccessful: false,
        plan,
        hasHiddenFindings,
      }),
    ).toEqual([]);
  });
});

describe("pagePendingPrompt", () => {
  const base = { eligibleSince: {}, deferred: [], now: NOW };

  it("is the highest-priority eligible key the page can render, whatever the order", () => {
    expect(
      pagePendingPrompt({ ...base, eligible: ["feedback", "upgrade_return"], renderable: ALL }),
    ).toBe("upgrade_return");
  });

  it("is null when nothing is eligible", () => {
    expect(pagePendingPrompt({ ...base, eligible: [], renderable: ALL })).toBeNull();
  });
});

describe("bounded blocking (PROMPT_BLOCK_MAX_MS)", () => {
  const DAY = 24 * HOUR;

  it("is exactly 7 days", () => {
    expect(PROMPT_BLOCK_MAX_MS).toBe(7 * DAY);
  });

  it.each([
    ["no eligibleSince", undefined, true],
    ["just eligible", ago(0), true],
    ["6d23h59m59.999s ago", ago(7 * DAY - 1), true],
    ["exactly 7d ago", ago(7 * DAY), false],
    ["30d ago", ago(30 * DAY), false],
  ])("isStillBlocking: %s -> %s", (_label, since, expected) => {
    expect(isStillBlocking(since, NOW)).toBe(expected);
  });

  it("review_popup pending for 6d23h blocks feedback on Home; at 7d it does not", () => {
    const at = (age: number) =>
      pick({
        eligible: ["review_popup", "feedback"],
        eligibleSince: { review_popup: ago(age) },
        renderable: HOME_PROMPTS,
      });
    expect(at(7 * DAY - HOUR)).toBeNull();
    expect(at(7 * DAY - 1)).toBeNull();
    expect(at(7 * DAY)).toBe("feedback");
  });

  it("upgrade_return pending 7d+ stops blocking feedback on Home too", () => {
    expect(
      pick({
        eligible: ["upgrade_return", "feedback"],
        eligibleSince: { upgrade_return: ago(8 * DAY) },
        renderable: HOME_PROMPTS,
      }),
    ).toBe("feedback");
  });

  it("a stale higher prompt still renders on its OWN page when the slot is free", () => {
    expect(
      pick({
        eligible: ["review_popup", "feedback"],
        eligibleSince: { review_popup: ago(30 * DAY) },
        renderable: ["review_popup"],
      }),
    ).toBe("review_popup");
  });

  it("a fresh higher prompt behind a stale one still blocks (each is checked in order)", () => {
    expect(
      pick({
        eligible: ["review_popup", "upgrade_return", "feedback"],
        eligibleSince: { review_popup: ago(30 * DAY), upgrade_return: ago(DAY) },
        renderable: HOME_PROMPTS,
      }),
    ).toBeNull();
  });

  it("the stale prompt renders on its page only AFTER the lower prompt's 24h window expires", () => {
    const holder = { lastPromptKey: "feedback", eligibleSince: { review_popup: ago(30 * DAY) } };
    // Feedback took the slot on Home 23h ago: the popup waits on its page...
    expect(
      pick({
        ...holder,
        lastPromptShownAt: ago(23 * HOUR),
        eligible: ["review_popup", "feedback"],
        renderable: ["review_popup"],
      }),
    ).toBeNull();
    // ...while Home keeps re-rendering the holder inside its window...
    expect(
      pick({
        ...holder,
        lastPromptShownAt: ago(23 * HOUR),
        eligible: ["review_popup", "feedback"],
        renderable: HOME_PROMPTS,
      }),
    ).toBe("feedback");
    // ...and at exactly 24h the popup renders on its page.
    expect(
      pick({
        ...holder,
        lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS),
        eligible: ["review_popup", "feedback"],
        renderable: ["review_popup"],
      }),
    ).toBe("review_popup");
  });
});

describe("pickPrompt: priority (no prompt shown yet)", () => {
  // Every ordered pair (higher, lower) from the priority list.
  const pairs: Array<[PromptKey, PromptKey]> = [];
  PROMPT_KEYS.forEach((higher, i) => {
    PROMPT_KEYS.slice(i + 1).forEach((lower) => pairs.push([higher, lower]));
  });

  it("covers all 3 priority pairs", () => {
    expect(pairs).toHaveLength(3);
  });

  it.each(pairs)("%s outranks %s, whatever order eligible lists them", (higher, lower) => {
    expect(pick({ eligible: [higher, lower] })).toBe(higher);
    expect(pick({ eligible: [lower, higher] })).toBe(higher);
  });

  it.each(pairs)(
    "%s pending blocks %s on a page that can render only the lower one",
    (higher, lower) => {
      expect(pick({ eligible: [higher, lower], renderable: [lower] })).toBeNull();
    },
  );

  it("all three eligible: review_popup", () => {
    expect(pick({ eligible: [...PROMPT_KEYS].reverse() })).toBe("review_popup");
  });

  it.each(PROMPT_KEYS)("only %s eligible: that prompt", (key) => {
    expect(pick({ eligible: [key] })).toBe(key);
  });

  it("empty eligible list: null", () => {
    expect(pick({ eligible: [] })).toBeNull();
  });

  it("empty eligible list inside a window: null", () => {
    expect(
      pick({ lastPromptKey: "feedback", lastPromptShownAt: ago(HOUR), eligible: [] }),
    ).toBeNull();
  });
});

describe("pickPrompt: page renderability", () => {
  it("Home with only feedback pending: feedback", () => {
    expect(pick({ eligible: ["feedback"], renderable: HOME_PROMPTS })).toBe("feedback");
  });

  it.each<PromptKey>(["review_popup", "upgrade_return"])(
    "Home with %s pending (and feedback eligible): nothing",
    (pending) => {
      expect(pick({ eligible: [pending, "feedback"], renderable: HOME_PROMPTS })).toBeNull();
    },
  );

  it("scan page with only feedback pending: nothing (it cannot render feedback)", () => {
    expect(
      pick({
        eligible: ["feedback"],
        renderable: scanResultsPrompts({
          scanCompletedAt: ago(DAY_MS),
          now: NOW,
          scanSuccessful: true,
          plan: "free",
          hasHiddenFindings: true,
        }),
      }),
    ).toBeNull();
  });

  it("paid scan page with upgrade_return somehow eligible: nothing (not renderable there)", () => {
    expect(
      pick({
        eligible: ["upgrade_return"],
        renderable: scanResultsPrompts({
          scanCompletedAt: ago(DAY_MS),
          now: NOW,
          scanSuccessful: true,
          plan: "Standard",
          hasHiddenFindings: true,
        }),
      }),
    ).toBeNull();
  });

  it("an empty renderable list never renders anything", () => {
    expect(pick({ eligible: [...PROMPT_KEYS], renderable: [] })).toBeNull();
  });
});

describe("pickPrompt: the 24h window", () => {
  it("the same prompt re-renders within 24h while it is still the top prompt", () => {
    expect(
      pick({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(23 * HOUR),
        eligible: ["feedback"],
      }),
    ).toBe("feedback");
  });

  // Changed on purpose (owner decision 1A): the old picker let the holder keep
  // re-rendering here. Now the higher prompt is pending, so nothing renders.
  it("the holder does NOT re-render once a higher-priority prompt is eligible: null", () => {
    expect(
      pick({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(HOUR),
        eligible: ["review_popup", "upgrade_return", "feedback"],
      }),
    ).toBeNull();
  });

  it("a different prompt is blocked within 24h", () => {
    expect(
      pick({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(HOUR),
        eligible: ["upgrade_return"],
      }),
    ).toBeNull();
  });

  it.each(PROMPT_KEYS)("a different prompt is blocked 1ms before 24h (last = %s)", (last) => {
    for (const other of PROMPT_KEYS.filter((k) => k !== last)) {
      expect(
        pick({
          lastPromptKey: last,
          lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS - MS),
          eligible: [other],
        }),
      ).toBeNull();
    }
  });

  it("a different prompt is allowed at exactly 24h (boundary)", () => {
    expect(
      pick({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS),
        eligible: ["upgrade_return"],
      }),
    ).toBe("upgrade_return");
  });

  it("at exactly 24h priority decides again (the holder may lose to a higher prompt)", () => {
    expect(
      pick({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS),
        eligible: ["feedback", "review_popup"],
      }),
    ).toBe("review_popup");
  });

  it("a different prompt is allowed after 24h", () => {
    expect(
      pick({
        lastPromptKey: "feedback",
        lastPromptShownAt: ago(3 * PROMPT_CAP_WINDOW_MS),
        eligible: ["upgrade_return"],
      }),
    ).toBe("upgrade_return");
  });

  it("the holder no longer eligible (dismissed) within 24h: null, not the next prompt", () => {
    expect(
      pick({
        lastPromptKey: "upgrade_return",
        lastPromptShownAt: ago(2 * HOUR),
        eligible: ["feedback"],
      }),
    ).toBeNull();
  });

  it("the holder no longer eligible and nothing else eligible: null", () => {
    expect(
      pick({ lastPromptKey: "review_popup", lastPromptShownAt: ago(2 * HOUR), eligible: [] }),
    ).toBeNull();
  });

  it("an unknown (retired) lastPromptKey within 24h still blocks every prompt", () => {
    for (const retired of ["review_banner", "some_retired_prompt"]) {
      expect(
        pick({ lastPromptKey: retired, lastPromptShownAt: ago(HOUR), eligible: [...PROMPT_KEYS] }),
      ).toBeNull();
    }
  });

  it("an unknown (retired) lastPromptKey stops blocking at exactly 24h", () => {
    expect(
      pick({
        lastPromptKey: "review_banner",
        lastPromptShownAt: ago(PROMPT_CAP_WINDOW_MS),
        eligible: ["feedback"],
      }),
    ).toBe("feedback");
  });

  it("a null lastPromptShownAt means no open window (key alone does not block)", () => {
    expect(
      pick({ lastPromptKey: "feedback", lastPromptShownAt: null, eligible: ["upgrade_return"] }),
    ).toBe("upgrade_return");
  });

  it("a null lastPromptKey means no open window (timestamp alone does not block)", () => {
    expect(
      pick({ lastPromptKey: null, lastPromptShownAt: ago(HOUR), eligible: ["upgrade_return"] }),
    ).toBe("upgrade_return");
  });

  it("a lastPromptShownAt in the future (clock skew) counts as inside the window", () => {
    expect(
      pick({
        lastPromptKey: "feedback",
        lastPromptShownAt: new Date(NOW.getTime() + HOUR),
        eligible: ["upgrade_return"],
      }),
    ).toBeNull();
  });

  it("the holder re-rendering still needs the page to be able to render it", () => {
    expect(
      pick({
        lastPromptKey: "upgrade_return",
        lastPromptShownAt: ago(HOUR),
        eligible: ["upgrade_return"],
        renderable: HOME_PROMPTS,
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
        "upgrade_return",
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

describe("a just-finished scan defers the review popup (re-audit #2)", () => {
  const MIN = 60 * 1000;
  const page = (completedAgo: number | null, plan = "free") => ({
    scanSuccessful: true,
    plan,
    hasHiddenFindings: true,
    scanCompletedAt: completedAgo === null ? null : ago(completedAgo),
    now: NOW,
  });

  it("is 10 minutes, and Home defers nothing", () => {
    expect(REVIEW_POPUP_MIN_SCAN_AGE_MS).toBe(10 * MIN);
    expect(HOME_DEFERRED_PROMPTS).toEqual([]);
  });

  it.each([
    ["just now", 0, false],
    ["9m59.999s ago", 10 * MIN - 1, false],
    ["exactly 10m ago", 10 * MIN, true],
    ["a day ago", DAY_MS, true],
  ])("scan completed %s: popup renderable %s", (_label, ago_, renderable) => {
    expect(scanResultsPrompts(page(ago_)).includes("review_popup")).toBe(renderable);
    expect(scanResultsDeferredPrompts(page(ago_))).toEqual(renderable ? [] : ["review_popup"]);
  });

  it("a scan with no completedAt is never deferred", () => {
    expect(scanResultsDeferredPrompts(page(null))).toEqual([]);
    expect(scanResultsPrompts(page(null))).toContain("review_popup");
  });

  it("an unsuccessful scan defers nothing (it renders nothing either)", () => {
    expect(scanResultsDeferredPrompts({ ...page(0), scanSuccessful: false })).toEqual([]);
  });

  it("just finished, popup and banner both pending: the BANNER renders (the popup does not block)", () => {
    const p = page(MIN);
    expect(
      pick({
        eligible: ["review_popup", "upgrade_return"],
        renderable: scanResultsPrompts(p),
        deferred: scanResultsDeferredPrompts(p),
      }),
    ).toBe("upgrade_return");
  });

  it("finished more than 10 minutes ago: the popup is picked as before", () => {
    const p = page(11 * MIN);
    expect(
      pick({
        eligible: ["review_popup", "upgrade_return"],
        renderable: scanResultsPrompts(p),
        deferred: scanResultsDeferredPrompts(p),
      }),
    ).toBe("review_popup");
  });

  it("just finished on a PAID shop: nothing renders, and the popup is not picked", () => {
    const p = page(MIN, "Standard");
    expect(
      pick({
        eligible: ["review_popup"],
        renderable: scanResultsPrompts(p),
        deferred: scanResultsDeferredPrompts(p),
      }),
    ).toBeNull();
  });
});
