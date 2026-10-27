/**
 * One-time "How did you find GhostCode?" card (install source). Client-safe:
 * the answer options, the copy, the eligibility rule and the parser the Home
 * action uses.
 *
 * The card sits at the END of Home, whenever a successful scan's results render
 * (owner decision 2026-10-27: get merchants to value first, ask after). It is
 * page content, not an interruptive prompt, so the cross-prompt cap
 * (./prompt-cap) does not count it. Answering or skipping retires it for good.
 * Telemetry: nudge_shown / nudge_converted (answered) / nudge_dismissed
 * (skipped), once per merchant each, under NUDGE_KEYS.INSTALL_SOURCE.
 */

/** Answer options, in display order. "other" carries the merchant's own words. */
export const INSTALL_SOURCE_OPTIONS = [
  { value: "app_store_search", label: "Searching the Shopify App Store" },
  { value: "app_store_browse", label: "Browsing the Shopify App Store" },
  { value: "sidekick", label: "Shopify Sidekick" },
  { value: "ai_assistant", label: "ChatGPT, Claude or another AI assistant" },
  { value: "web_search", label: "Google or another search engine" },
  { value: "article", label: "An article or guide" },
  { value: "referral", label: "An agency, developer or another merchant" },
  { value: "other", label: "Other" },
] as const;

export type InstallSource = (typeof INSTALL_SOURCE_OPTIONS)[number]["value"];

/** Longest "other" answer stored (the input's maxLength; longer is truncated). */
export const INSTALL_SOURCE_OTHER_MAX_LEN = 100;

export const INSTALL_SOURCE_COPY = {
  heading: "One quick question: how did you find GhostCode?",
  // No "first scan" wording: existing merchants see it after any later scan.
  body: "Knowing where merchants hear about us helps us reach more stores like yours. We only ask once.",
  otherPlaceholder: "Tell us where",
  submit: "Send",
  skip: "Skip",
  missingChoice: "Choose an answer, or skip.",
  saveFailed: "That didn't save. Please try again.",
} as const;

/**
 * Show the card when Home renders a successful scan's results and the
 * merchant has neither answered nor skipped. Internal stores never see it.
 */
export function shouldShowInstallSourceCard(input: {
  hasResults: boolean;
  isInternal: boolean;
  installSourceAnsweredAt: Date | null;
  installSourceSkippedAt: Date | null;
}): boolean {
  return (
    input.hasResults &&
    !input.isInternal &&
    input.installSourceAnsweredAt === null &&
    input.installSourceSkippedAt === null
  );
}

export type InstallSourceAnswer = { source: InstallSource; other: string | null };

/**
 * Parse a submitted answer. Returns null for a missing or unknown choice.
 * `other` text is kept only for the "other" choice: trimmed, blank to null,
 * truncated to INSTALL_SOURCE_OTHER_MAX_LEN.
 */
export function parseInstallSourceAnswer(raw: {
  source: unknown;
  other?: unknown;
}): InstallSourceAnswer | null {
  const option = INSTALL_SOURCE_OPTIONS.find((o) => o.value === raw.source);
  if (!option) return null;
  if (option.value !== "other") return { source: option.value, other: null };
  const text = typeof raw.other === "string" ? raw.other.trim() : "";
  return {
    source: option.value,
    other: text === "" ? null : text.slice(0, INSTALL_SOURCE_OTHER_MAX_LEN),
  };
}
