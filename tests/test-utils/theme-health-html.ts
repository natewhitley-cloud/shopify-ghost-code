/**
 * Reads the pieces of Home's theme health section (gc-i6du) out of statically
 * rendered markup: the verdict line, the chips, the amber action box and the
 * theme lines. Shared by the component test and the Home route test so both
 * assert on the same reading of the markup.
 */
import { expect } from "vitest";

import {
  BG_BADGE_SUCCESS,
  COLOR_SUCCESS,
  COLOR_WARNING,
  SUCCESS_TEXT_STRONG,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  WARN_BD,
  WARN_TEXT_STRONG,
} from "../../app/styles/shared";

/** React escapes an apostrophe in text. */
export const esc = (text: string) => text.replace(/'/g, "&#x27;");
export const unesc = (text: string) => text.replace(/&#x27;/g, "'");

export type Tone = "ok" | "warn" | "other";

/** The verdict line (its dot's tone and its sentence), or null when there is none. */
export function verdictOf(html: string): { tone: Tone; text: string } | null {
  const m = html.match(
    /<p[^>]*><span aria-hidden="true" style="[^"]*background:(#[0-9a-fA-F]{6})"><\/span><span[^>]*>([^<]*)<\/span><\/p>/,
  );
  if (!m) return null;
  const tone = m[1] === COLOR_SUCCESS ? "ok" : m[1] === COLOR_WARNING ? "warn" : "other";
  return { tone, text: unesc(m[2]) };
}

export const OK_CHIP = `background:${BG_BADGE_SUCCESS};color:${SUCCESS_TEXT_STRONG}`;
export const WARN_CHIP = `background:${WARN_BD};color:${WARN_TEXT_STRONG}`;
export const HIDDEN = "position:absolute;width:1px;height:1px;";

export interface Chip {
  tone: Tone;
  glyph: string;
  /** The visually hidden words before the label. */
  prefix: string;
  label: string;
}

/** Every chip in the section, in order. Throws if an <li> is not a chip. */
export function chipsOf(html: string): Chip[] {
  const chips = [
    ...html.matchAll(
      /<li style="([^"]*)"><span aria-hidden="true"[^>]*>([^<]*)<\/span><span[^>]*><span style="([^"]*)">([^<]*)<\/span>([^<]*)<\/span><\/li>/g,
    ),
  ].map(([, style, glyph, hidden, prefix, label]): Chip => {
    expect(hidden.startsWith(HIDDEN), "the prefix is visually hidden").toBe(true);
    const tone = style.includes(OK_CHIP) ? "ok" : style.includes(WARN_CHIP) ? "warn" : "other";
    return { tone, glyph, prefix, label };
  });
  expect(chips, "every <li> is a chip").toHaveLength((html.match(/<li/g) ?? []).length);
  return chips;
}

/** "ok Clean: Tracking still running": one chip as a line of text. */
export const chipLines = (html: string) =>
  chipsOf(html).map((c) => `${c.tone} ${c.prefix}${c.label}`);
export const greenLabels = (html: string) =>
  chipsOf(html)
    .filter((c) => c.tone === "ok")
    .map((c) => c.label);

export const ACTION_ACCENT = `border-left:5px solid ${COLOR_WARNING}`;

/** The amber action box: its markup and its entries, or null when it is absent. */
export function actionOf(
  html: string,
): { box: string; entries: Array<{ names: string; reason: string | null }> } | null {
  const at = html.indexOf(ACTION_ACCENT);
  if (at === -1) return null;
  const box = html.slice(html.lastIndexOf("<div", at), html.indexOf("</div></div>", at) + 12);
  const entries = [
    ...box.matchAll(
      /<div style="min-width:0"><strong[^>]*>([^<]*)<\/strong>(?:<span[^>]*>([^<]*)<\/span>)?<\/div>/g,
    ),
  ].map((m) => ({ names: unesc(m[1]), reason: m[2] === undefined ? null : unesc(m[2]) }));
  return { box, entries };
}

export const BODY = '<div style="display:flex;flex-direction:column;gap:12px;min-width:0">';

/** The theme lines at the foot of the section: each line's text and style. */
export function themeLines(html: string): Array<{ text: string; style: string }> {
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
