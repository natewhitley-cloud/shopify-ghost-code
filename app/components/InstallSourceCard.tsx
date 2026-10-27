/**
 * One-time "How did you find GhostCode?" card (gc-3twe), rendered at the very
 * end of Home's results view. Page content, not an interruptive prompt (see
 * app/lib/install-source.ts).
 *
 * Its own fetcher, so Send / Skip never interrupt another Home fetcher. The
 * card hides optimistically once Send or Skip is submitted (like the feedback
 * nudge's "Not now"); the loader's revalidation then drops it for good. It
 * comes back only if the server rejects the answer, with the missing-choice
 * message. Native radios and a text input, so the values serialize into the
 * submit without the hidden-input bridge Polaris web components would need.
 */
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import {
  INSTALL_SOURCE_COPY,
  INSTALL_SOURCE_OPTIONS,
  INSTALL_SOURCE_OTHER_MAX_LEN,
} from "../lib/install-source";
import { BORDER_STRONG, COLOR_CRITICAL, TEXT_PRIMARY, visuallyHidden } from "../styles/shared";

/** The Home action's replies to this card's intents. */
type InstallSourceReply = { installSourceError?: string };

const optionStyle: React.CSSProperties = {
  fontSize: "14px",
  color: TEXT_PRIMARY,
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

/**
 * What Send posts for the current selection, or null when nothing is chosen
 * (the card then shows missingChoice and posts nothing). Other text rides
 * along only with the "other" choice.
 */
export function installSourceSendPayload(
  choice: string | null,
  other: string,
): Record<string, string> | null {
  if (choice === null) return null;
  return {
    intent: "install-source-answer",
    source: choice,
    other: choice === "other" ? other : "",
  };
}

/** The inline message for a server rejection of the card's Send. */
export function installSourceErrorMessage(code: string): string {
  return code === "save_failed"
    ? INSTALL_SOURCE_COPY.saveFailed
    : INSTALL_SOURCE_COPY.missingChoice;
}

export function InstallSourceCard() {
  const fetcher = useFetcher<InstallSourceReply>();
  const [choice, setChoice] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A server rejection (no valid choice, or the write failed) brings the card
  // back with the message.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.installSourceError) {
      setHidden(false);
      setError(installSourceErrorMessage(fetcher.data.installSourceError));
    }
  }, [fetcher.state, fetcher.data]);

  if (hidden) return null;

  const handleSend = () => {
    const payload = installSourceSendPayload(choice, other);
    if (payload === null) {
      setError(INSTALL_SOURCE_COPY.missingChoice);
      return;
    }
    setError(null);
    setHidden(true);
    fetcher.submit(payload, { method: "POST" });
  };

  const handleSkip = () => {
    setHidden(true);
    fetcher.submit({ intent: "install-source-skip" }, { method: "POST" });
  };

  return (
    <div style={{ marginTop: "16px" }}>
      <s-section heading={INSTALL_SOURCE_COPY.heading}>
        <s-stack direction="block" gap="base">
          <s-paragraph>{INSTALL_SOURCE_COPY.body}</s-paragraph>
          <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
            <legend style={visuallyHidden}>{INSTALL_SOURCE_COPY.heading}</legend>
            <s-stack direction="block" gap="small-200">
              {INSTALL_SOURCE_OPTIONS.map((o) => (
                <label key={o.value} style={optionStyle}>
                  <input
                    type="radio"
                    name="installSource"
                    value={o.value}
                    checked={choice === o.value}
                    onChange={() => {
                      setChoice(o.value);
                      setError(null);
                    }}
                  />{" "}
                  {o.value === "other" ? `${o.label}:` : o.label}
                  {o.value === "other" && (
                    <input
                      type="text"
                      aria-label={INSTALL_SOURCE_COPY.otherPlaceholder}
                      maxLength={INSTALL_SOURCE_OTHER_MAX_LEN}
                      placeholder={INSTALL_SOURCE_COPY.otherPlaceholder}
                      value={other}
                      onChange={(e) => setOther(e.target.value)}
                      onFocus={() => setChoice("other")}
                      style={{
                        font: "inherit",
                        padding: "2px 6px",
                        border: `1px solid ${BORDER_STRONG}`,
                        borderRadius: "6px",
                        width: "180px",
                      }}
                    />
                  )}
                </label>
              ))}
            </s-stack>
          </fieldset>
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: "14px", color: COLOR_CRITICAL }}>
              {error}
            </p>
          )}
          <s-stack direction="inline" gap="base">
            <s-button variant="secondary" onClick={handleSend}>
              {INSTALL_SOURCE_COPY.submit}
            </s-button>
            <s-button variant="tertiary" onClick={handleSkip}>
              {INSTALL_SOURCE_COPY.skip}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </div>
  );
}
