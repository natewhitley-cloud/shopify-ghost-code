import { FormattedDate } from "./FormattedDate";
import { securityRiskStyles as s } from "./SecurityRiskBanner";
import {
  GUARD_ACKNOWLEDGE,
  GUARD_CHECK_STEPS,
  GUARD_GUIDE_LABEL,
  GUARD_GUIDE_URL,
  GUARD_PLAN_NOTE,
  GUARD_RISK_LABEL,
  guardIncidentBody,
  guardIncidentTitle,
  guardSightingsLead,
  guardStatusWords,
  type GuardIncidentView,
  type GuardStatusView,
} from "../lib/storefront-guard-copy";
import { textSubduedSm } from "../styles/shared";

/** "Open since {date} · shown on every plan", plus "Seen N times, last on {date}". */
function SeenLine({ incident }: { incident: GuardIncidentView }) {
  const again = guardSightingsLead(incident);
  return (
    <div style={{ ...textSubduedSm, overflowWrap: "anywhere" }}>
      Open since <FormattedDate value={incident.openedAt} />
      {again && (
        <>
          {". "}
          {again} <FormattedDate value={incident.lastSeenAt} />
        </>
      )}{" "}
      · {GUARD_PLAN_NOTE}
    </div>
  );
}

/**
 * Checkout guard incident on Home (gc-1q1s.6), on EVERY plan.
 *
 *   - KNOWN_MALICIOUS and SCRIPT_LOADER: the red security banner frame
 *     (shared with SecurityRiskBanner), the facts, the "What to check" steps
 *     and the checklist guide link.
 *   - NEW_SCRIPT_HOST: a warning banner (not a security risk: most new hosts
 *     are app installs) with "This is expected".
 */
export function StorefrontIncidentBanner({
  incident,
  onAcknowledge,
  acknowledging = false,
}: {
  incident: GuardIncidentView;
  onAcknowledge?: (incidentId: string) => void;
  acknowledging?: boolean;
}) {
  const heading = guardIncidentTitle(incident);
  if (incident.kind === "NEW_SCRIPT_HOST") {
    return (
      <s-banner tone="warning" heading={heading}>
        <s-stack direction="block" gap="base">
          <s-paragraph>{guardIncidentBody(incident)}</s-paragraph>
          <SeenLine incident={incident} />
          {onAcknowledge && (
            <div>
              <s-button
                variant="secondary"
                disabled={acknowledging || undefined}
                onClick={() => onAcknowledge(incident.id)}
              >
                {GUARD_ACKNOWLEDGE}
              </s-button>
            </div>
          )}
        </s-stack>
      </s-banner>
    );
  }
  const headingId = `guard-incident-${incident.id}-title`;
  return (
    <section aria-labelledby={headingId} style={s.card}>
      <div style={s.bar}>
        <span aria-hidden="true">{s.WARNING_SIGN}</span>
        <span>{GUARD_RISK_LABEL}</span>
      </div>
      <div style={s.body}>
        <h2 id={headingId} style={s.title}>
          {heading}
        </h2>
        <p style={s.facts}>{guardIncidentBody(incident)}</p>
        <div style={s.facts}>
          <strong>What to check</strong>
          <ol style={{ margin: "4px 0 0", paddingLeft: "20px" }}>
            {GUARD_CHECK_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        <div style={s.actions}>
          {/* Leaves the admin: a plain anchor in a new tab, with `rel`. */}
          <a
            href={GUARD_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "14px" }}
          >
            {GUARD_GUIDE_LABEL}
          </a>
        </div>
        <SeenLine incident={incident} />
      </div>
    </section>
  );
}

/** Home's one checkout guard status line (only while the guard is live). */
export function GuardStatusLine({ status }: { status: GuardStatusView }) {
  const words = guardStatusWords(status);
  return (
    <div style={{ ...textSubduedSm, overflowWrap: "anywhere" }} data-testid="guard-status">
      {words.lead}
      {status.date && words.tail !== "" && (
        <>
          {" "}
          <FormattedDate value={status.date} />
          {words.tail}
        </>
      )}
    </div>
  );
}
