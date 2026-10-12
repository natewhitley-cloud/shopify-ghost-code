/**
 * Reads the pieces of Home's theme health section (gc-i6du) out of statically
 * rendered markup: the verdict line, the chips, the amber action box and the
 * theme lines. Shared by the component test and the Home route test so both
 * assert on the same reading of the markup.
 *
 * Every reader PROVES it can see the section before it reports that something
 * is absent, so a negative assertion ("no verdict", "no green chip", "no
 * action box") cannot pass just because the markup changed under the reader:
 *   - each reader throws unless the section's heading is in the markup;
 *   - a dot or a chip whose colours it cannot classify throws (no "other");
 *   - "nothing found" is cross-checked against the section's TEXT (the verdict
 *     sentences, the chips' hidden prefixes), which does not depend on the
 *     tags or styles the reader matches on.
 */
import { expect } from "vitest";

import {
  BG_BADGE_SUCCESS,
  COLOR_SUCCESS,
  COLOR_WARNING,
  LANE_GREY_FILL,
  SUCCESS_TEXT_STRONG,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  WARN_BD,
  WARN_BG,
  WARN_TEXT_STRONG,
} from "../../app/styles/shared";

/** React escapes an apostrophe in text. */
export const esc = (text: string) => text.replace(/'/g, "&#x27;");
export const unesc = (text: string) => text.replace(/&#x27;/g, "'");

/** The section's heading: every reader requires it (see the file comment). */
export const SECTION_HEADING = '<h2 id="theme-health-heading"';

/**
 * Throws unless `html` holds the theme health section. Call it (or any reader
 * below, which all do) before a raw negative such as
 * `expect(html).not.toContain(...)`, so the negative is about a section that
 * is really there.
 */
export function expectSection(html: string): void {
  expect(html.includes(SECTION_HEADING), "the theme health section is in the markup").toBe(true);
}

/** The verdict dot's tone. */
export type Tone = "ok" | "neutral" | "warn";
/** A chip is green or amber, never grey. */
export type ChipTone = Exclude<Tone, "neutral">;

const DOT_TONE: Record<string, Tone> = {
  [COLOR_SUCCESS]: "ok",
  [LANE_GREY_FILL]: "neutral",
  [COLOR_WARNING]: "warn",
};

/** Text and style only a verdict line has, whatever tags it is built from. */
const VERDICT_SIGNS =
  /no known malicious code found|nothing malicious|couldn(?:'|&#x27;)t run, including|border-radius:5px/i;

/**
 * The verdict line (its dot's tone and its sentence), or null when there is
 * none. Throws when the dot's colour is not a known tone, and when it finds no
 * verdict line although the section still carries a verdict's text or dot.
 */
export function verdictOf(html: string): { tone: Tone; text: string } | null {
  expectSection(html);
  const m = html.match(
    /<p[^>]*><span aria-hidden="true" style="[^"]*background:(#[0-9a-fA-F]{6})"><\/span><span[^>]*>([^<]*)<\/span><\/p>/,
  );
  if (!m) {
    expect(
      VERDICT_SIGNS.test(html),
      "no verdict line was read, but the section has a verdict's text or dot",
    ).toBe(false);
    return null;
  }
  const tone = DOT_TONE[m[1]];
  if (!tone) throw new Error(`verdict dot colour ${m[1]} is not a known tone`);
  return { tone, text: unesc(m[2]) };
}

export const OK_CHIP = `background:${BG_BADGE_SUCCESS};color:${SUCCESS_TEXT_STRONG}`;
export const WARN_CHIP = `background:${WARN_BD};color:${WARN_TEXT_STRONG}`;
export const HIDDEN = "position:absolute;width:1px;height:1px;";

/** The words every chip carries (visually hidden), whatever its markup. */
const CHIP_PREFIXES = ["Clean: ", "Not checked: ", "Partly checked: "];
/** The prefixes of the amber chips: the checks the action box explains. */
const GAP_PREFIXES = ["Not checked: ", "Partly checked: "];

const count = (html: string, needle: string) => html.split(needle).length - 1;

export interface Chip {
  tone: ChipTone;
  glyph: string;
  /** The visually hidden words before the label. */
  prefix: string;
  label: string;
}

/**
 * Every chip in the section, in order. Throws when an <li> is not a chip, when
 * a chip's colours are neither the green nor the amber pair, and when the
 * chips it read are not every chip the section's text says is there (so an
 * empty result means the section really has no chip).
 */
export function chipsOf(html: string): Chip[] {
  expectSection(html);
  const chips = [
    ...html.matchAll(
      /<li style="([^"]*)"><span aria-hidden="true"[^>]*>([^<]*)<\/span><span[^>]*><span style="([^"]*)">([^<]*)<\/span>([^<]*)<\/span><\/li>/g,
    ),
  ].map(([, style, glyph, hidden, prefix, label]): Chip => {
    expect(hidden.startsWith(HIDDEN), "the prefix is visually hidden").toBe(true);
    const tone = style.includes(OK_CHIP) ? "ok" : style.includes(WARN_CHIP) ? "warn" : null;
    if (!tone) throw new Error(`chip "${prefix}${label}" has no known tone: ${style}`);
    return { tone, glyph, prefix, label };
  });
  expect(chips, "every <li> is a chip").toHaveLength((html.match(/<li/g) ?? []).length);
  // Independent of the tags and styles matched above: each chip says its
  // prefix in words, and each tone's colours appear once per chip of it.
  expect(
    CHIP_PREFIXES.reduce((sum, prefix) => sum + count(html, `>${prefix}<`), 0),
    "every chip prefix in the section was read as a chip",
  ).toBe(chips.length);
  expect(count(html, OK_CHIP), "green chip colours in the section").toBe(
    chips.filter((c) => c.tone === "ok").length,
  );
  expect(count(html, WARN_CHIP), "amber chip colours in the section").toBe(
    chips.filter((c) => c.tone === "warn").length,
  );
  return chips;
}

/** `chipsOf`, for a section that must have chips: throws when it reads none. */
export function someChipsOf(html: string): Chip[] {
  const chips = chipsOf(html);
  expect(chips.length, "at least one chip was read").toBeGreaterThan(0);
  return chips;
}

/** "ok Clean: Tracking still running": one chip as a line of text. */
export const chipLines = (html: string) =>
  chipsOf(html).map((c) => `${c.tone} ${c.prefix}${c.label}`);
/**
 * The labels of the green chips. For "this check is NOT green" claims, so it
 * throws when no chip at all was read: an empty list then means every chip
 * that is there is amber, not that the reader saw nothing.
 */
export const greenLabels = (html: string) =>
  someChipsOf(html)
    .filter((c) => c.tone === "ok")
    .map((c) => c.label);

export const ACTION_ACCENT = `border-left:5px solid ${COLOR_WARNING}`;

/**
 * The amber action box: its markup and its entries, or null when it is absent.
 * Throws when it finds no box although the section has an amber chip (every
 * check that did not fully run is explained in the box) or the box's tint, and
 * when it finds a box but can read no entry in it.
 */
export function actionOf(
  html: string,
): { box: string; entries: Array<{ names: string; reason: string | null }> } | null {
  expectSection(html);
  const at = html.indexOf(ACTION_ACCENT);
  if (at === -1) {
    for (const sign of [...GAP_PREFIXES.map((p) => `>${p}<`), WARN_CHIP, `background:${WARN_BG}`]) {
      expect(html.includes(sign), `no action box was read, but the section has ${sign}`).toBe(
        false,
      );
    }
    return null;
  }
  const box = html.slice(html.lastIndexOf("<div", at), html.indexOf("</div></div>", at) + 12);
  const entries = [
    ...box.matchAll(
      /<div style="min-width:0"><strong[^>]*>([^<]*)<\/strong>(?:<span[^>]*>([^<]*)<\/span>)?<\/div>/g,
    ),
  ].map((m) => ({ names: unesc(m[1]), reason: m[2] === undefined ? null : unesc(m[2]) }));
  expect(entries.length, "the action box has at least one entry").toBeGreaterThan(0);
  return { box, entries };
}

export const BODY = '<div style="display:flex;flex-direction:column;gap:12px;min-width:0">';

/** The theme lines at the foot of the section: each line's text and style. */
export function themeLines(html: string): Array<{ text: string; style: string }> {
  expectSection(html);
  const at = html.indexOf(BODY);
  if (at === -1) return [];
  const tail = html
    .slice(at)
    .match(/((?:<div style="[^"]*">[^<]*<\/div>)+)<\/div><\/section>$/)?.[1];
  return [...(tail ?? "").matchAll(/<div style="([^"]*)">([^<]*)<\/div>/g)].map((m) => ({
    style: m[1],
    text: unesc(m[2]),
  }));
}
export const themeText = (html: string) => themeLines(html).map((l) => l.text);

export const SUBDUED = `color:${TEXT_SUBDUED};font-size:13px`;
export const PRIMARY = `font-size:14px;color:${TEXT_PRIMARY}`;
