/**
 * Help page messages (gc-3twe; was the gc-97k.3 feedback survey, ported from
 * ClearSignal ba-1zbf.1).
 *
 * Owns: (1) validation of the submitted message, (2) the durable write to
 * MerchantFeedback (with server-built support context for bug reports), (3)
 * the once-per-merchant feedback-nudge `converted` stage, for topic "feedback"
 * only (it stamps Shop.feedbackSubmittedAt and so retires the nudge), and (4)
 * the fire-and-forget email to the support inbox (support-email.server).
 *
 * Contact email privacy: the address is stored only together with the
 * merchant's consent ("You can email me about this request"). With consent,
 * the support email carries it (a "Reply to:" line and Resend's reply_to), so
 * a support request can be answered from the inbox without a DB lookup. That
 * is a deliberate tradeoff: the merchant asked to be contacted, but inbox
 * copies are outside shop/redact's reach, unlike the DB row. Without consent
 * no address is stored or sent anywhere.
 *
 * Deliberately NOT ported: ClearSignal's CSAT-gated review CTA. Review asks
 * must be neutral (Shopify App Store policy), so the success state shows the
 * same ask to every "feedback" sender; see app/lib/feedback-nudge.ts.
 */
import { recordNudgeStageOnce } from "./nudge-stage.server";
import { NUDGE_KEYS } from "./nudge-telemetry.server";
import { sendSupportEmail } from "./support-email.server";
import { FEEDBACK_MAX_EMAIL_LEN, FEEDBACK_MAX_TEXT_LEN } from "../lib/feedback-nudge";
import { helpTopicLabel, parseHelpTopic, SUPPORT_EMAIL } from "../lib/help";
import type { HelpTopic } from "../lib/help";
import { logger } from "../lib/logger.server";
import { safeErrorFields } from "../lib/safe-error";
import {
  countMerchantFeedbackSince,
  createMerchantFeedback,
} from "../models/merchant-feedback.server";
import { getScansForShop } from "../models/scan.server";

export const CSAT_MIN = 1;
export const CSAT_MAX = 5;

/** Help messages a shop may send per rolling 24h; more are refused (no email). */
export const HELP_MAX_MESSAGES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A validated Help message. contactEmail non-null means the merchant consented. */
export type HelpMessage = {
  topic: HelpTopic;
  message: string;
  csat: number | null;
  contactEmail: string | null;
};

export type HelpMessageValidation = { ok: true; value: HelpMessage } | { ok: false; error: string };

export const HELP_ERRORS = {
  topic: "Choose what this is about.",
  message: "Please write a message.",
  csat: "Please choose a rating from 1 to 5.",
  email: "That email doesn't look right. Leave it blank to skip contact.",
  emailWithoutConsent: "Tick the box so we can email you, or leave the email blank.",
  consentWithoutEmail: "Add your email so we can reply.",
  rateLimited: `You've sent several messages today. Email ${SUPPORT_EMAIL} and we'll pick it up there.`,
} as const;

/**
 * True when the shop already sent HELP_MAX_MESSAGES_PER_DAY messages in the
 * rolling 24h before `now`, so this one must be refused (the 10th is accepted,
 * the 11th is not). Counts persisted rows, so it holds across tabs and reloads.
 */
export async function isHelpRateLimited(shopId: string, now: Date = new Date()) {
  const sent = await countMerchantFeedbackSince(shopId, new Date(now.getTime() - DAY_MS));
  return sent >= HELP_MAX_MESSAGES_PER_DAY;
}

/**
 * Validate and normalize a raw Help form submission. Rules, checked in order:
 *   - topic must be one of HELP_TOPICS;
 *   - message is required (after trim) and capped at FEEDBACK_MAX_TEXT_LEN
 *     (truncated; the textarea's maxLength stops a normal browser first);
 *   - csat is read for topic "feedback" only, where it is optional: blank or
 *     absent = null, anything else must be an integer 1..5 (else an error).
 *     For every other topic it is ignored, whatever was sent;
 *   - a non-blank contactEmail must look like an email and fit
 *     FEEDBACK_MAX_EMAIL_LEN (an over-long one is REJECTED, not truncated: a
 *     cut-off address is a wrong address);
 *   - email and consent come as a pair: an email without the ticked box, or the
 *     ticked box without an email, is an error. contactConsent is ticked only
 *     when it is exactly "on" (a native checkbox's value).
 */
export function validateHelpMessage(raw: {
  topic: unknown;
  message: unknown;
  csat?: unknown;
  contactEmail?: unknown;
  contactConsent?: unknown;
}): HelpMessageValidation {
  const topic = parseHelpTopic(raw.topic);
  if (topic === null) return { ok: false, error: HELP_ERRORS.topic };

  const message = normalizeText(raw.message);
  if (message === null) return { ok: false, error: HELP_ERRORS.message };

  let csat: number | null = null;
  if (topic === "feedback" && !isBlank(raw.csat)) {
    csat = coerceCsat(raw.csat);
    if (csat === null) return { ok: false, error: HELP_ERRORS.csat };
  }

  const email = normalizeText(raw.contactEmail);
  if (email !== null && (email.length > FEEDBACK_MAX_EMAIL_LEN || !isPlausibleEmail(email))) {
    return { ok: false, error: HELP_ERRORS.email };
  }

  const consent = raw.contactConsent === "on";
  if (email !== null && !consent) return { ok: false, error: HELP_ERRORS.emailWithoutConsent };
  if (email === null && consent) return { ok: false, error: HELP_ERRORS.consentWithoutEmail };

  return {
    ok: true,
    value: { topic, message: message.slice(0, FEEDBACK_MAX_TEXT_LEN), csat, contactEmail: email },
  };
}

/** Integer 1..5 or null. Accepts a number or numeric string; rejects everything else. */
function coerceCsat(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < CSAT_MIN || n > CSAT_MAX) return null;
  return n;
}

/** Absent: undefined, null (form field missing) or a blank string. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

/** Trim and collapse blank to null. Non-strings become null. */
function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Deliberately simple, but safe to put in a reply_to header: ASCII only, one
 * `@`, a dotted domain of letters, digits and hyphens, and none of
 * `, < > " ( ) ; :` or whitespace (each could split or smuggle an address).
 */
function isPlausibleEmail(value: string): boolean {
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value);
}

/**
 * Support context for a bug report: `plan=<plan>; latestScan=<id or none>`.
 * Built from the session shop's own rows, never from client input. The scan
 * lookup is best-effort: a failed read says "unavailable" rather than failing
 * the submit.
 */
export async function buildBugContext(shop: { id: string; domain: string; plan: string }) {
  let latestScan: string;
  try {
    const { items } = await getScansForShop(shop.id, { limit: 1 });
    latestScan = items[0]?.id ?? "none";
  } catch (err) {
    logger.warn("help-context-scan-lookup-failed", {
      shop: shop.domain,
      ...safeErrorFields(err),
    });
    latestScan = "unavailable";
  }
  return `plan=${shop.plan}; latestScan=${latestScan}`;
}

/**
 * Persist a validated Help message, record the feedback nudge's `converted`
 * stage (topic "feedback" only; stamps feedbackSubmittedAt on the first one,
 * so the nudge never returns), and email the support inbox.
 *
 * The DB row is the source of truth and its write may throw. Everything after
 * it is best-effort: recordNudgeStageOnce never throws, and the support email
 * is fire-and-forget so neither a slow nor a failing send can fail the submit.
 * `shop.domain` must be session.shop unchanged.
 */
export async function createHelpMessage(
  shop: { id: string; domain: string; plan: string },
  input: HelpMessage,
) {
  const context = input.topic === "bug" ? await buildBugContext(shop) : null;
  const record = await createMerchantFeedback(shop.id, {
    topic: input.topic,
    message: input.message,
    csat: input.csat,
    contactEmail: input.contactEmail,
    contactConsentAt: input.contactEmail !== null ? new Date() : null,
    context,
  });

  if (input.topic === "feedback") {
    await recordNudgeStageOnce(NUDGE_KEYS.FEEDBACK, "converted", shop.domain);
  }

  // Promise.resolve().then() also catches a synchronous throw from the send.
  // A failed send records a durable api_error itself (support-email.server).
  void Promise.resolve()
    .then(() =>
      sendSupportEmail({
        subject: `GhostCode help: ${helpTopicLabel(input.topic)} from ${shop.domain}`,
        text: formatHelpEmail(shop.domain, input, context),
        replyTo: input.contactEmail,
        shopDomain: shop.domain,
        topic: input.topic,
      }),
    )
    .catch((err: unknown) => {
      logger.error("help-support-email-failed", {
        shop: shop.domain,
        ...safeErrorFields(err),
      });
    });

  return record;
}

/**
 * Plaintext support email body. "Reply to:" carries the merchant's address
 * only when they consented (a validated HelpMessage's contactEmail is non-null
 * only with consent); otherwise it says none was given.
 */
export function formatHelpEmail(
  shopDomain: string,
  input: HelpMessage,
  context: string | null,
): string {
  return [
    `Shop: ${shopDomain}`,
    `Topic: ${helpTopicLabel(input.topic)}`,
    ...(input.csat !== null ? [`CSAT: ${input.csat}/5`] : []),
    ...(context !== null ? [`Context: ${context}`] : []),
    `Reply to: ${input.contactEmail ?? "(no email given; no reply wanted)"}`,
    "",
    input.message,
  ].join("\n");
}
