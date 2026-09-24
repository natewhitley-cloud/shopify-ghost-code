/**
 * Merchant feedback capture (gc-97k.3, ported from ClearSignal ba-1zbf.1).
 *
 * Owns: (1) validation of the submitted survey, (2) the durable write to
 * MerchantFeedback, (3) the once-per-merchant `converted` stage (which also
 * stamps Shop.feedbackSubmittedAt and so retires the nudge), and (4) the
 * fire-and-forget operator email.
 *
 * Deliberately NOT ported: ClearSignal's CSAT-gated review CTA. Review asks
 * must be neutral (Shopify App Store policy), so the success state shows the
 * same ask to every submitter; see app/lib/feedback-nudge.ts.
 */
import { recordNudgeStageOnce } from "./nudge-stage.server";
import { NUDGE_KEYS } from "./nudge-telemetry.server";
import { sendOpsAlert } from "./ops-alert.server";
import { FEEDBACK_MAX_EMAIL_LEN, FEEDBACK_MAX_TEXT_LEN } from "../lib/feedback-nudge";
import { logger } from "../lib/logger.server";
import { createMerchantFeedback } from "../models/merchant-feedback.server";
import type { MerchantFeedbackData } from "../models/merchant-feedback.server";

export const CSAT_MIN = 1;
export const CSAT_MAX = 5;

export type FeedbackInput = MerchantFeedbackData;

export type FeedbackValidation = { ok: true; value: FeedbackInput } | { ok: false; error: string };

/**
 * Validate and normalize a raw form submission. CSAT is the only required
 * field and must be an integer in [1,5]. Text answers are trimmed, collapsed to
 * null when blank, and capped at FEEDBACK_MAX_TEXT_LEN (truncated, as in
 * ClearSignal; the form's maxLength stops a normal browser from exceeding it).
 * A non-blank contactEmail must look like an email and fit
 * FEEDBACK_MAX_EMAIL_LEN; an over-long one is REJECTED, not truncated, because
 * a cut-off address is a wrong address.
 */
export function validateFeedbackInput(raw: {
  csat: unknown;
  valuable?: unknown;
  improvement?: unknown;
  wtp?: unknown;
  contactEmail?: unknown;
}): FeedbackValidation {
  const csat = coerceCsat(raw.csat);
  if (csat === null) {
    return { ok: false, error: "Please choose a rating from 1 to 5." };
  }

  const email = normalizeText(raw.contactEmail);
  if (email !== null && (email.length > FEEDBACK_MAX_EMAIL_LEN || !isPlausibleEmail(email))) {
    return {
      ok: false,
      error: "That email doesn't look right. Leave it blank to skip contact.",
    };
  }

  return {
    ok: true,
    value: {
      csat,
      valuable: capText(normalizeText(raw.valuable)),
      improvement: capText(normalizeText(raw.improvement)),
      wtp: capText(normalizeText(raw.wtp)),
      contactEmail: email,
    },
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

/** Trim and collapse blank to null. Non-strings become null. */
function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function capText(value: string | null): string | null {
  return value === null ? null : value.slice(0, FEEDBACK_MAX_TEXT_LEN);
}

/** Deliberately permissive: one `@`, a dot in the domain, no spaces. */
function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Persist a validated submission, record the once-per-merchant `converted`
 * stage (stamps feedbackSubmittedAt on the first submission only, so the nudge
 * never returns), and email the operator.
 *
 * The DB row is the source of truth and its write may throw. Everything after
 * it is best-effort: recordNudgeStageOnce never throws, and the ops email is
 * fire-and-forget so neither a slow nor a failing send can fail the submit.
 * `shop.domain` must be session.shop unchanged.
 */
export async function createFeedback(shop: { id: string; domain: string }, input: FeedbackInput) {
  const record = await createMerchantFeedback(shop.id, input);

  await recordNudgeStageOnce(NUDGE_KEYS.FEEDBACK, "converted", shop.domain);

  // Promise.resolve().then() also catches a synchronous throw from the send.
  void Promise.resolve()
    .then(() =>
      sendOpsAlert(
        `New feedback: CSAT ${input.csat}/5 from ${shop.domain}`,
        formatFeedbackEmail(shop.domain, input),
      ),
    )
    .catch((err: unknown) => {
      logger.error("feedback-ops-alert-failed", {
        shop: shop.domain,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return record;
}

/** Plaintext operator email body with every field. */
export function formatFeedbackEmail(shopDomain: string, input: FeedbackInput): string {
  return [
    `Shop: ${shopDomain}`,
    `CSAT: ${input.csat}/5`,
    "",
    `Most valuable: ${input.valuable ?? "(no answer)"}`,
    "",
    `Should improve: ${input.improvement ?? "(no answer)"}`,
    "",
    `Worth paying for: ${input.wtp ?? "(no answer)"}`,
    "",
    input.contactEmail
      ? `Contact: ${input.contactEmail} (merchant asked to be contacted)`
      : "Contact: (merchant did not leave an email)",
  ].join("\n");
}
