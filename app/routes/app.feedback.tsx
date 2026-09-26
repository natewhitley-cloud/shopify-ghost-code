/**
 * /app/feedback (gc-97k.3): the merchant feedback survey. CSAT 1-5 (required),
 * three optional open-text answers and an optional follow-up email. Reached
 * from the home-page feedback nudge (`?src=nudge`, which counts the nudge click
 * once per merchant) but also directly reachable.
 *
 * On submit the action validates server-side, persists the row, records the
 * once-per-merchant `converted` stage (stamps feedbackSubmittedAt) and emails
 * the operator (fire-and-forget). The success state shows the SAME neutral App
 * Store review link to every submitter, whatever their rating: Shopify's review
 * policy forbids asking only satisfied merchants, so the ask never depends on
 * CSAT. That link is in-flow (the merchant is already on this page), not an
 * interruptive prompt, so the cross-prompt cap does not count it.
 *
 * Every field is a native input so it serializes into FormData without the
 * hidden-input bridge Polaris web components would need.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher } from "react-router";

import {
  APP_STORE_REVIEW_URL,
  FEEDBACK_MAX_EMAIL_LEN,
  FEEDBACK_MAX_TEXT_LEN,
  FEEDBACK_THANKS_COPY,
} from "../lib/feedback-nudge";
import { getShopMetadata } from "../models/shop.server";
import { createFeedback, validateFeedbackInput } from "../services/feedback.server";
import { recordNudgeStageOnce } from "../services/nudge-stage.server";
import { NUDGE_KEYS } from "../services/nudge-telemetry.server";
import { authenticate } from "../shopify.server";
import { BORDER_STRONG, TEXT_PRIMARY, TEXT_SUBDUED } from "../styles/shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Nudge-funnel "clicked": only an arrival through the nudge CTA counts, at
  // most once per merchant. recordNudgeStageOnce never throws.
  if (new URL(request.url).searchParams.get("src") === "nudge") {
    await recordNudgeStageOnce(NUDGE_KEYS.FEEDBACK, "clicked", session.shop);
  }

  return null;
};

type ActionResult = { ok: true } | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);
  if (!shop) {
    return { ok: false, error: "Shop not found. Please reinstall the app." };
  }

  const formData = await request.formData();
  const validation = validateFeedbackInput({
    csat: formData.get("csat"),
    valuable: formData.get("valuable"),
    improvement: formData.get("improvement"),
    wtp: formData.get("wtp"),
    contactEmail: formData.get("contactEmail"),
  });
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  await createFeedback({ id: shop.id, domain: session.shop }, validation.value);

  return { ok: true };
};

const CSAT_OPTIONS = [
  { value: "1", label: "1 - Very unsatisfied" },
  { value: "2", label: "2 - Unsatisfied" },
  { value: "3", label: "3 - Neutral" },
  { value: "4", label: "4 - Satisfied" },
  { value: "5", label: "5 - Very satisfied" },
];

const TEXT_QUESTIONS = [
  { name: "valuable", label: "What's most valuable?" },
  { name: "improvement", label: "What should we improve?" },
  { name: "wtp", label: "What would make Ghost Code worth paying for?" },
] as const;

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "14px",
  fontFamily: "inherit",
  color: TEXT_PRIMARY,
  border: `1px solid ${BORDER_STRONG}`,
  borderRadius: "8px",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "14px",
  fontWeight: 600,
  color: TEXT_PRIMARY,
  marginBottom: "4px",
};

const hintStyle: React.CSSProperties = { fontSize: "13px", color: TEXT_SUBDUED };

const BackLink = () => (
  <Link to="/app" slot="primary-action">
    Back to home
  </Link>
);

/**
 * Success state. Takes no rating on purpose: the review ask is identical for
 * every submitter (no sentiment gating).
 */
export function FeedbackThanks() {
  return (
    <s-page heading={FEEDBACK_THANKS_COPY.heading}>
      <BackLink />
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>{FEEDBACK_THANKS_COPY.body}</s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" href={APP_STORE_REVIEW_URL} target="_blank">
              {FEEDBACK_THANKS_COPY.reviewCta}
            </s-button>
            <Link to="/app">{FEEDBACK_THANKS_COPY.skip}</Link>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export default function FeedbackPage() {
  const fetcher = useFetcher<typeof action>();
  const submitting = fetcher.state !== "idle";
  const result = fetcher.data;

  if (result?.ok) return <FeedbackThanks />;

  return (
    <s-page heading="Share your feedback">
      <BackLink />
      <s-section>
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-paragraph>A few quick questions. Only the rating is required.</s-paragraph>

            <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
              <legend style={labelStyle}>How satisfied are you with Ghost Code?</legend>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
                {CSAT_OPTIONS.map((o) => (
                  <label key={o.value} style={{ fontSize: "14px", color: TEXT_PRIMARY }}>
                    <input type="radio" name="csat" value={o.value} required /> {o.label}
                  </label>
                ))}
              </div>
            </fieldset>

            {TEXT_QUESTIONS.map((q) => (
              <div key={q.name}>
                <label style={labelStyle} htmlFor={`feedback-${q.name}`}>
                  {q.label}
                </label>
                <textarea
                  id={`feedback-${q.name}`}
                  name={q.name}
                  maxLength={FEEDBACK_MAX_TEXT_LEN}
                  rows={3}
                  style={{ ...fieldStyle, resize: "vertical" }}
                />
              </div>
            ))}

            <div>
              <label style={labelStyle} htmlFor="feedback-email">
                Email (optional, if you would like us to follow up)
              </label>
              <input
                id="feedback-email"
                name="contactEmail"
                type="email"
                maxLength={FEEDBACK_MAX_EMAIL_LEN}
                placeholder="you@example.com"
                style={fieldStyle}
              />
              <span style={hintStyle}>Leave blank if you would rather not be contacted.</span>
            </div>

            {result && !result.ok && (
              <s-banner tone="critical">
                <s-paragraph>{result.error}</s-paragraph>
              </s-banner>
            )}

            <div>
              <s-button type="submit" variant="primary" {...(submitting ? { loading: true } : {})}>
                Send feedback
              </s-button>
            </div>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Share your feedback">
      <s-section>
        <s-banner tone="critical">
          <s-paragraph>
            Something went wrong with the feedback page. Please refresh and try again.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
