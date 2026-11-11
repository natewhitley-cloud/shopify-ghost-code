/**
 * parse5 agreement check for clean-copy removal spans (gc-t44r 3A).
 *
 * removal-span.ts decides spans with its own tokenizer model. As a second,
 * independent opinion, the Liquid-masked copy of the file (maskedHtml: every
 * Liquid token replaced by filler, offsets unchanged) is parsed with parse5,
 * a spec-complete HTML parser, and a span is confirmed only when parse5 sees
 * the same thing:
 *   - GHOST_SCRIPT: an HTML-namespace `script` element (not in template
 *     content) whose start tag starts at span.start and whose end tag ends at
 *     span.end.
 *   - GHOST_STYLE / GHOST_PRECONNECT: an HTML-namespace `link` element (not in
 *     template content) whose start tag is exactly [span.start, span.end).
 *   - GHOST_SNIPPET (render tag or bare `{% liquid %}` line): the whole span
 *     lies in one Text node whose parent is an HTML element that is not a
 *     text-only element (script, style, textarea, title, ...) and not in
 *     template content, or the span touches no located node at all.
 * Anything else is refused with PARSER_DISAGREES.
 *
 * Hard limit: parse5's tree builder is quadratic in element nesting depth
 * (20k nested <div> take seconds), so a file with more than MAX_START_TAGS
 * start tags is not parsed and every span in it is refused.
 *
 * Server-only: removal-span.ts stays import-free because a client route
 * imports FIXABLE_FINDING_TYPES from it.
 */
import { html, parse, type DefaultTreeAdapterMap } from "parse5";

import { maskedHtml, type RemovalSpan, type SpanResult } from "./removal-span";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** Elements whose content is text, never markup: a Liquid span there is not a statement. */
const TEXT_PARENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

/** Above this many start tags the file is not parsed (see header). */
export const MAX_START_TAGS = 10_000;

function tooManyTags(text: string): boolean {
  let n = 0;
  for (let i = text.indexOf("<"); i !== -1; i = text.indexOf("<", i + 1)) {
    const c = text.charCodeAt(i + 1);
    if (((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) && ++n > MAX_START_TAGS) return true;
  }
  return false;
}

type Parsed = {
  /** script/link elements by start-tag start offset (HTML namespace, live). */
  elements: Map<number, { name: string; startTagEnd: number; endTagEnd: number | null }>;
  /** Text nodes a Liquid span may sit in: [start, end) pairs, sorted. */
  texts: Array<[number, number]>;
  /** Every located token (text, comment, doctype, start/end tags): sorted. */
  located: Array<[number, number]>;
};

function parseMasked(content: string): Parsed | null {
  const masked = maskedHtml(content);
  if (tooManyTags(masked)) return null;
  const doc = parse(masked, { sourceCodeLocationInfo: true });
  const elements: Parsed["elements"] = new Map();
  const texts: Array<[number, number]> = [];
  const located: Array<[number, number]> = [];
  // Iterative walk (deep documents must not overflow the stack).
  const stack: Array<{ node: Node; inert: boolean; textOk: boolean }> = [
    { node: doc, inert: false, textOk: true },
  ];
  while (stack.length > 0) {
    const { node, inert, textOk } = stack.pop() as { node: Node; inert: boolean; textOk: boolean };
    const loc = "sourceCodeLocation" in node ? node.sourceCodeLocation : null;
    if (node.nodeName === "#text") {
      if (loc) {
        located.push([loc.startOffset, loc.endOffset]);
        if (textOk && !inert) texts.push([loc.startOffset, loc.endOffset]);
      }
      continue;
    }
    if (node.nodeName === "#comment" || node.nodeName === "#documentType") {
      if (loc) located.push([loc.startOffset, loc.endOffset]);
      continue;
    }
    if (!("childNodes" in node)) continue;
    let childInert = inert;
    let childTextOk = textOk;
    if ("tagName" in node) {
      const el = node as Element;
      const eloc = el.sourceCodeLocation;
      if (eloc?.startTag) located.push([eloc.startTag.startOffset, eloc.startTag.endOffset]);
      if (eloc?.endTag) located.push([eloc.endTag.startOffset, eloc.endTag.endOffset]);
      const isHtml = el.namespaceURI === html.NS.HTML;
      if (
        isHtml &&
        !inert &&
        eloc?.startTag &&
        (el.tagName === "script" || el.tagName === "link")
      ) {
        elements.set(eloc.startTag.startOffset, {
          name: el.tagName,
          startTagEnd: eloc.startTag.endOffset,
          endTagEnd: eloc.endTag ? eloc.endTag.endOffset : null,
        });
      }
      childTextOk = isHtml && !TEXT_PARENTS.has(el.tagName);
      if (el.tagName === "template" && "content" in el) {
        // Template content is inert: nothing in it is live code.
        stack.push({
          node: (el as DefaultTreeAdapterMap["template"]).content,
          inert: true,
          textOk: false,
        });
        childInert = true;
      }
    }
    for (const child of node.childNodes)
      stack.push({ node: child, inert: childInert, textOk: childTextOk });
  }
  const byStart = (a: [number, number], b: [number, number]) => a[0] - b[0];
  texts.sort(byStart);
  located.sort(byStart);
  return { elements, texts, located };
}

/** The last interval starting at or before x (intervals sorted by start), or -1. */
function lastStartingAtOrBefore(list: Array<[number, number]>, x: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= x) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Whether [s, e) lies inside one allowed text node, or touches no located node. */
function liquidSpanOk(p: Parsed, s: number, e: number): boolean {
  const k = lastStartingAtOrBefore(p.texts, s);
  if (k !== -1 && e <= p.texts[k][1]) return true;
  // No located node may overlap [s, e). Located intervals can nest
  // (an element's start tag holds no children), so scan back to any that
  // could still reach s, then forward to e.
  let j = lastStartingAtOrBefore(p.located, e - 1);
  for (; j >= 0; j--) {
    const [a, b] = p.located[j];
    if (b > s && a < e) return false;
    if (b <= s && a < s - 4096) break;
  }
  return true;
}

/**
 * A checker for one file: parses the masked copy once, on first use, and
 * confirms or refuses each span located by removalSpanFor.
 */
export function createSpanCrossCheck(
  content: string,
): (findingType: string, span: RemovalSpan) => SpanResult {
  let parsed: Parsed | null | undefined;
  const refused: SpanResult = { ok: false, reason: "PARSER_DISAGREES" };
  return (findingType, span) => {
    if (parsed === undefined) parsed = parseMasked(content);
    if (parsed === null) return refused;
    const { start, end } = span;
    if (findingType === "GHOST_SNIPPET") {
      return liquidSpanOk(parsed, start, end) ? { ok: true, span } : refused;
    }
    const el = parsed.elements.get(start);
    if (!el) return refused;
    if (findingType === "GHOST_SCRIPT") {
      return el.name === "script" && el.endTagEnd === end ? { ok: true, span } : refused;
    }
    if (findingType === "GHOST_STYLE" || findingType === "GHOST_PRECONNECT") {
      return el.name === "link" && el.startTagEnd === end ? { ok: true, span } : refused;
    }
    return refused;
  };
}
