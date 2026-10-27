/**
 * Tests for app/components/InstallSourceCard.tsx (gc-3twe). Rendered with
 * react-dom/server inside a routes stub (the card owns a fetcher); the Send
 * payload rule is tested directly (no DOM environment for clicks).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, it, expect } from "vitest";

import {
  InstallSourceCard,
  installSourceErrorMessage,
  installSourceSendPayload,
} from "../../app/components/InstallSourceCard";
import {
  INSTALL_SOURCE_COPY,
  INSTALL_SOURCE_OPTIONS,
  INSTALL_SOURCE_OTHER_MAX_LEN,
} from "../../app/lib/install-source";

function render(): string {
  const Stub = createRoutesStub([{ path: "/app", Component: InstallSourceCard }]);
  return renderToStaticMarkup(<Stub initialEntries={["/app"]} />);
}

describe("InstallSourceCard", () => {
  const html = render();

  it("renders the heading, body, one native radio per option and the Other text input", () => {
    expect(html).toContain(`heading="${INSTALL_SOURCE_COPY.heading}"`);
    expect(html).toContain(INSTALL_SOURCE_COPY.body);
    expect(html.match(/type="radio" name="installSource"/g)).toHaveLength(
      INSTALL_SOURCE_OPTIONS.length,
    );
    for (const o of INSTALL_SOURCE_OPTIONS) expect(html).toContain(`value="${o.value}"`);
    expect(html).toContain("Other:");
    expect(html).toMatch(new RegExp(`type="text"[^>]*maxLength="${INSTALL_SOURCE_OTHER_MAX_LEN}"`));
    expect(html).toContain(`placeholder="${INSTALL_SOURCE_COPY.otherPlaceholder}"`);
  });

  it("groups the radios in a fieldset named by a (visually hidden) legend", () => {
    expect(html).toMatch(
      new RegExp(
        `<fieldset[^>]*><legend[^>]*>${INSTALL_SOURCE_COPY.heading.replace("?", "\\?")}</legend>`,
      ),
    );
    expect(html.indexOf("<fieldset")).toBeLessThan(html.indexOf('type="radio"'));
    expect(html.lastIndexOf('type="radio"')).toBeLessThan(html.indexOf("</fieldset>"));
  });

  it("starts with nothing chosen and no error", () => {
    expect(html).not.toContain("checked");
    expect(html).not.toContain(INSTALL_SOURCE_COPY.missingChoice);
  });

  it("Send is secondary and Skip tertiary", () => {
    expect(html).toMatch(/<s-button variant="secondary">Send<\/s-button>/);
    expect(html).toMatch(/<s-button variant="tertiary">Skip<\/s-button>/);
  });
});

describe("installSourceErrorMessage", () => {
  it("a failed save asks to try again; anything else is the missing choice", () => {
    expect(installSourceErrorMessage("save_failed")).toBe("That didn't save. Please try again.");
    expect(installSourceErrorMessage("missing_choice")).toBe(INSTALL_SOURCE_COPY.missingChoice);
    expect(installSourceErrorMessage("anything")).toBe(INSTALL_SOURCE_COPY.missingChoice);
  });
});

describe("installSourceSendPayload", () => {
  it("nothing chosen: no payload (the card shows missingChoice instead)", () => {
    expect(installSourceSendPayload(null, "typed anyway")).toBeNull();
  });

  it("a listed choice posts the answer intent without other text", () => {
    expect(installSourceSendPayload("sidekick", "stale text")).toEqual({
      intent: "install-source-answer",
      source: "sidekick",
      other: "",
    });
  });

  it("other posts its text (the server trims and caps it)", () => {
    expect(installSourceSendPayload("other", " a podcast ")).toEqual({
      intent: "install-source-answer",
      source: "other",
      other: " a podcast ",
    });
  });
});
