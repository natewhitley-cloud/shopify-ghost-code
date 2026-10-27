/**
 * Tests for app/lib/help.ts (gc-3twe): topics and per-topic copy.
 */
import { describe, it, expect } from "vitest";

import {
  HELP_TOPICS,
  helpMessageField,
  helpTopicLabel,
  parseHelpTopic,
  SUPPORT_EMAIL,
} from "../../app/lib/help";
import { SUPPORT_EMAIL as SERVER_SUPPORT_EMAIL } from "../../app/services/summary-email.server";

describe("help topics", () => {
  it("lists the five topics in order with their labels", () => {
    expect(HELP_TOPICS.map((t) => [t.value, t.label])).toEqual([
      ["bug", "Something's broken"],
      ["howto", "How do I…?"],
      ["feedback", "Idea or feedback"],
      ["billing", "Billing"],
      ["other", "Other"],
    ]);
  });

  it("parses only exact topic values", () => {
    for (const t of HELP_TOPICS) expect(parseHelpTopic(t.value)).toBe(t.value);
    for (const v of [undefined, null, "", "Bug", "sales", 1]) expect(parseHelpTopic(v)).toBeNull();
  });

  it("labels a topic", () => {
    expect(helpTopicLabel("billing")).toBe("Billing");
  });
});

describe("helpMessageField", () => {
  it("bug and feedback get their own label and placeholder", () => {
    expect(helpMessageField("bug")).toEqual({
      label: "What happened?",
      placeholder: "What you did, what you expected, and what happened instead.",
    });
    expect(helpMessageField("feedback")).toEqual({
      label: "Your idea or feedback",
      placeholder: "What's working, what isn't, what you'd add.",
    });
  });

  it.each(["howto", "billing", "other"] as const)("%s: generic label, no placeholder", (t) => {
    expect(helpMessageField(t)).toEqual({ label: "Your message", placeholder: null });
  });
});

it("the server's SUPPORT_EMAIL is the client-safe constant (one source)", () => {
  expect(SUPPORT_EMAIL).toBe("support@alpenglowsoftware.com");
  expect(SERVER_SUPPORT_EMAIL).toBe(SUPPORT_EMAIL);
});
