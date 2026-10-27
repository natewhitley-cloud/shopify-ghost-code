/**
 * Help page (/app/help, gc-3twe): topics, copy and links. Client-safe, shared
 * by the route's form and the server-side validator.
 *
 * The page replaced the feedback survey: "Idea or feedback" is one topic among
 * five, and the feedback nudge links here with ?topic=feedback.
 */

/** Topics, in display order. The submitted `topic` is the source of truth server-side. */
export const HELP_TOPICS = [
  { value: "bug", label: "Something's broken" },
  { value: "howto", label: "How do I…?" },
  { value: "feedback", label: "Idea or feedback" },
  { value: "billing", label: "Billing" },
  { value: "other", label: "Other" },
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number]["value"];

/** Preselected when the URL names no valid topic. */
export const DEFAULT_HELP_TOPIC: HelpTopic = "bug";

/** The topic for a raw value, or null when it is not one of HELP_TOPICS. */
export function parseHelpTopic(value: unknown): HelpTopic | null {
  return HELP_TOPICS.find((t) => t.value === value)?.value ?? null;
}

export function helpTopicLabel(topic: HelpTopic): string {
  return HELP_TOPICS.find((t) => t.value === topic)?.label ?? topic;
}

/** The message box's label and placeholder for a topic (null = no placeholder). */
export function helpMessageField(topic: HelpTopic): { label: string; placeholder: string | null } {
  if (topic === "bug") {
    return {
      label: "What happened?",
      placeholder: "What you did, what you expected, and what happened instead.",
    };
  }
  if (topic === "feedback") {
    return {
      label: "Your idea or feedback",
      placeholder: "What's working, what isn't, what you'd add.",
    };
  }
  return { label: "Your message", placeholder: null };
}

export const HELP_COPY = {
  heading: "Help",
  intro: "Questions, problems or ideas: send them here. A person reads every message.",
  topicLabel: "What is this about?",
  csatLegend: "How satisfied are you with GhostCode? (optional)",
  bugContextNote: "We'll include your store, plan and latest scan ID so you don't have to.",
  emailLabel: "Your email (optional)",
  emailHint: "Only needed if you want a reply.",
  consentLabel: "You can email me about this request",
  submit: "Send",
  sentHeading: "Message sent",
  sentNoEmail: "Thanks. We read every message.",
  sendAnother: "Send another message",
  otherWaysHeading: "Other ways to get help",
} as const;

/** "Thanks. We'll reply to <email>." */
export function helpSentWithEmail(email: string): string {
  return `Thanks. We'll reply to ${email}.`;
}

/** The support inbox. Client-safe; summary-email.server re-exports it. */
export const SUPPORT_EMAIL = "support@alpenglowsoftware.com";

/** GhostCode guides on the public site (alpenglow-site, published). */
export const HELP_GUIDES = [
  {
    label: "Removing leftover app code",
    url: "https://alpenglowsoftware.com/guides/remove-leftover-shopify-app-code/",
  },
  {
    label: "Does uninstalling an app remove its code?",
    url: "https://alpenglowsoftware.com/guides/does-uninstalling-shopify-app-remove-code/",
  },
] as const;
