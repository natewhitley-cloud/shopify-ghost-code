/**
 * /app/help (gc-3twe; replaces the gc-97k.3 feedback survey): one form for
 * questions, problems and ideas, plus other ways to get help. Reached from the
 * nav, and from the home-page feedback nudge (`?topic=feedback&src=nudge`;
 * `src=nudge` counts the nudge click once per merchant). `?topic=` preselects
 * a valid topic, else "bug".
 *
 * On submit the action validates server-side (the submitted `topic` is the
 * source of truth; topic switching is client state only), persists the row
 * (with server-built support context for bug reports, never client input),
 * records the feedback nudge's `converted` stage for topic "feedback" only, and
 * emails the support inbox (fire-and-forget). A shop is limited to
 * HELP_MAX_MESSAGES_PER_DAY messages per rolling 24h; past that the action
 * refuses (no row, no email) and points to the support address. Send is
 * disabled while a submit is in flight. For topic "feedback" the success
 * state also shows the SAME neutral App Store review link to every sender,
 * whatever their rating: Shopify's review policy forbids asking only satisfied
 * merchants. That link is in-flow, not an interruptive prompt, so the
 * cross-prompt cap does not count it.
 *
 * Every field is a native input so it serializes into FormData without the
 * hidden-input bridge Polaris web components would need.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRouteError } from "react-router";

import { reportRouteError } from "../lib/client-error-reporter";
import {
  APP_STORE_REVIEW_URL,
  FEEDBACK_MAX_EMAIL_LEN,
  FEEDBACK_MAX_TEXT_LEN,
  FEEDBACK_THANKS_COPY,
} from "../lib/feedback-nudge";
import {
  DEFAULT_HELP_TOPIC,
  HELP_COPY,
  HELP_GUIDES,
  HELP_TOPICS,
  helpMessageField,
  helpSentWithEmail,
  parseHelpTopic,
  SUPPORT_EMAIL,
} from "../lib/help";
import type { HelpTopic } from "../lib/help";
import { getShopMetadata } from "../models/shop.server";
import {
  createHelpMessage,
  HELP_ERRORS,
  isHelpRateLimited,
  validateHelpMessage,
} from "../services/feedback.server";
import { recordNudgeStageOnce } from "../services/nudge-stage.server";
import { NUDGE_KEYS } from "../services/nudge-telemetry.server";
import { authenticate } from "../shopify.server";
import { BORDER_STRONG, TEXT_PRIMARY, TEXT_SUBDUED } from "../styles/shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;

  // Nudge-funnel "clicked": only an arrival through the nudge CTA counts, at
  // most once per merchant. recordNudgeStageOnce never throws.
  if (params.get("src") === "nudge") {
    await recordNudgeStageOnce(NUDGE_KEYS.FEEDBACK, "clicked", session.shop);
  }

  return { initialTopic: parseHelpTopic(params.get("topic")) ?? DEFAULT_HELP_TOPIC };
};

type ActionResult =
  | { ok: true; topic: HelpTopic; replyTo: string | null }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);
  if (!shop) {
    return { ok: false, error: "Shop not found. Please reinstall the app." };
  }

  const formData = await request.formData();
  const validation = validateHelpMessage({
    topic: formData.get("topic"),
    message: formData.get("message"),
    csat: formData.get("csat"),
    contactEmail: formData.get("contactEmail"),
    contactConsent: formData.get("contactConsent"),
  });
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  if (await isHelpRateLimited(shop.id)) {
    return { ok: false, error: HELP_ERRORS.rateLimited };
  }

  await createHelpMessage({ id: shop.id, domain: session.shop, plan: shop.plan }, validation.value);

  return { ok: true, topic: validation.value.topic, replyTo: validation.value.contactEmail };
};

const CSAT_OPTIONS = [
  { value: "1", label: "1 - Very unsatisfied" },
  { value: "2", label: "2 - Unsatisfied" },
  { value: "3", label: "3 - Neutral" },
  { value: "4", label: "4 - Satisfied" },
  { value: "5", label: "5 - Very satisfied" },
];

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

const optionStyle: React.CSSProperties = { fontSize: "14px", color: TEXT_PRIMARY };

const hintStyle: React.CSSProperties = { fontSize: "13px", color: TEXT_SUBDUED };

/**
 * Success state. Takes no rating on purpose: for topic "feedback" the review
 * ask is identical for every sender (no sentiment gating); other topics get
 * no review ask.
 */
export function HelpSent({
  topic,
  replyTo,
  onReset,
}: {
  topic: HelpTopic;
  replyTo: string | null;
  onReset: () => void;
}) {
  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-banner tone="success" heading={HELP_COPY.sentHeading}>
          <s-paragraph>
            {replyTo !== null ? helpSentWithEmail(replyTo) : HELP_COPY.sentNoEmail}
          </s-paragraph>
        </s-banner>
        {topic === "feedback" && (
          <s-stack direction="block" gap="base">
            <s-paragraph>{FEEDBACK_THANKS_COPY.body}</s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" href={APP_STORE_REVIEW_URL} target="_blank">
                {FEEDBACK_THANKS_COPY.reviewCta}
              </s-button>
              <Link to="/app">{FEEDBACK_THANKS_COPY.skip}</Link>
            </s-stack>
          </s-stack>
        )}
        <div>
          <s-button variant="secondary" onClick={onReset}>
            {HELP_COPY.sendAnother}
          </s-button>
        </div>
      </s-stack>
    </s-section>
  );
}

/** Email and guide links. Both leave the admin: plain anchors (guides in a new tab). */
export function OtherWaysToGetHelp() {
  return (
    <s-section heading={HELP_COPY.otherWaysHeading}>
      <s-stack direction="block" gap="small-200">
        <s-paragraph>
          Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </s-paragraph>
        <s-paragraph>
          Guides:{" "}
          {HELP_GUIDES.map((g, i) => (
            <span key={g.url}>
              {i > 0 && " · "}
              <a href={g.url} target="_blank" rel="noopener noreferrer">
                {g.label}
              </a>
            </span>
          ))}
        </s-paragraph>
      </s-stack>
    </s-section>
  );
}

export default function HelpPage() {
  const { initialTopic } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const submitting = fetcher.state !== "idle";
  const result = fetcher.data;

  const [topic, setTopic] = useState<HelpTopic>(initialTopic);
  // A later navigation to /app/help?topic=... reuses this mounted component.
  useEffect(() => setTopic(initialTopic), [initialTopic]);

  // "Send another message": hide the result it was shown for and remount the
  // form (clears every uncontrolled field). The topic stays as it was.
  const [resetFor, setResetFor] = useState<ActionResult | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const handleReset = () => {
    setResetFor(result);
    setFormKey((k) => k + 1);
  };

  const sent = result?.ok && result !== resetFor ? result : null;
  const error = result && !result.ok && result !== resetFor ? result.error : null;
  const messageField = helpMessageField(topic);

  return (
    <s-page heading={HELP_COPY.heading}>
      {sent ? (
        <HelpSent topic={sent.topic} replyTo={sent.replyTo} onReset={handleReset} />
      ) : (
        <s-section>
          <fetcher.Form
            method="post"
            key={formKey}
            // Enter in a field also submits: ignore it while one is in flight.
            onSubmit={(e) => {
              if (submitting) e.preventDefault();
            }}
          >
            <s-stack direction="block" gap="base">
              <s-paragraph>{HELP_COPY.intro}</s-paragraph>

              <div>
                <label style={labelStyle} htmlFor="help-topic">
                  {HELP_COPY.topicLabel}
                </label>
                <select
                  id="help-topic"
                  name="topic"
                  value={topic}
                  onChange={(e) => setTopic(parseHelpTopic(e.target.value) ?? DEFAULT_HELP_TOPIC)}
                  style={fieldStyle}
                >
                  {HELP_TOPICS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={labelStyle} htmlFor="help-message">
                  {messageField.label}
                </label>
                <textarea
                  id="help-message"
                  name="message"
                  required
                  maxLength={FEEDBACK_MAX_TEXT_LEN}
                  rows={5}
                  {...(messageField.placeholder ? { placeholder: messageField.placeholder } : {})}
                  style={{ ...fieldStyle, resize: "vertical" }}
                />
              </div>

              {/* Below the message on purpose (owner request), and optional. */}
              {topic === "feedback" && (
                <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
                  <legend style={labelStyle}>{HELP_COPY.csatLegend}</legend>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
                    {CSAT_OPTIONS.map((o) => (
                      <label key={o.value} style={optionStyle}>
                        <input type="radio" name="csat" value={o.value} /> {o.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {topic === "bug" && <span style={hintStyle}>{HELP_COPY.bugContextNote}</span>}

              <div>
                <label style={labelStyle} htmlFor="help-email">
                  {HELP_COPY.emailLabel}
                </label>
                <input
                  id="help-email"
                  name="contactEmail"
                  type="email"
                  maxLength={FEEDBACK_MAX_EMAIL_LEN}
                  placeholder="you@example.com"
                  aria-describedby="help-email-hint"
                  style={fieldStyle}
                />
                <span id="help-email-hint" style={hintStyle}>
                  {HELP_COPY.emailHint}
                </span>
              </div>

              <label style={optionStyle}>
                <input type="checkbox" name="contactConsent" value="on" /> {HELP_COPY.consentLabel}
              </label>

              {error && (
                <s-banner tone="critical">
                  <s-paragraph>{error}</s-paragraph>
                </s-banner>
              )}

              <div>
                <s-button
                  type="submit"
                  variant="primary"
                  {...(submitting ? { loading: true, disabled: true } : {})}
                >
                  {HELP_COPY.submit}
                </s-button>
              </div>
            </s-stack>
          </fetcher.Form>
        </s-section>
      )}
      <OtherWaysToGetHelp />
    </s-page>
  );
}

export function ErrorBoundary() {
  // Browser-side telemetry (gc-nn6); the UI below is unchanged.
  reportRouteError(useRouteError());
  return (
    <s-page heading={HELP_COPY.heading}>
      <s-section>
        <s-banner tone="critical">
          <s-paragraph>
            Something went wrong with the help page. Please refresh and try again.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
