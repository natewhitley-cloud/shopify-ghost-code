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
 *     lies in one located Text node whose parent is an HTML element that is
 *     not a text-only element (script, style, textarea, title, ...) and not
 *     in template content. Masked Liquid is non-whitespace filler, so live
 *     Liquid always lands in a Text node (even foster-parented or after
 *     </html>); a span parse5 drops (inside a stray or merged tag, in a
 *     frameset) is refused.
 * Anything else is refused with PARSER_DISAGREES.
 *
 * Hard limits (memory and time stay bounded; over a limit, every span in the
 * file is refused):
 *   - MAX_START_TAGS: the tree builder is quadratic in nesting depth (20k
 *     nested <div> take seconds), so a file with more start tags is not parsed.
 *   - MAX_TREE_NODES: adoption-agency reconstruction re-creates open
 *     formatting elements in every later block, so N unclosed `<b>` and M
 *     blocks make N*M nodes (4,900 x 4,900 from 105 KB ran Node out of a 4 GB
 *     heap). A counting tree adapter stops the parse once the budget is spent.
 *   - Any parse5 throw (the budget sentinel or a parser bug) refuses the file;
 *     the result is cached, so the file is parsed at most once, and one log
 *     line (no content) is written.
 *
 * Server-only: removal-span.ts stays import-free because a client route
 * imports FIXABLE_FINDING_TYPES from it.
 */
import { defaultTreeAdapter, html, parse, type DefaultTreeAdapterMap } from "parse5";

import { logger } from "./logger.server";
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

/**
 * Above this many tree nodes the parse stops (see header). Without
 * reconstruction a file under MAX_START_TAGS makes at most one element per
 * start tag plus a few implied ones (html/head/body, tbody/tr per table
 * part), one text node per gap between tokens, and one node per comment or
 * doctype: about 3 x 10,000 for the largest allowed file, plus its comments.
 * 100,000 leaves room for that and for ordinary reconstruction (a stray <b>
 * over thousands of sections), while capping the tree at tens of MB.
 */
export const MAX_TREE_NODES = 100_000;

/** Thrown by the counting adapter when the node budget is spent. */
class NodeBudgetSpent extends Error {}

/** parse5's default adapter, counting every node it creates. */
function countingAdapter(): typeof defaultTreeAdapter {
  let left = MAX_TREE_NODES;
  const spend = () => {
    if (--left < 0) throw new NodeBudgetSpent("node budget spent");
  };
  const a = defaultTreeAdapter;
  return {
    ...a,
    createElement(tagName, namespaceURI, attrs) {
      spend();
      return a.createElement(tagName, namespaceURI, attrs);
    },
    createCommentNode(data) {
      spend();
      return a.createCommentNode(data);
    },
    insertText(parentNode, text) {
      // The default adapter merges into a trailing text node (no new node).
      const last = parentNode.childNodes[parentNode.childNodes.length - 1];
      if (!last || !a.isTextNode(last)) spend();
      a.insertText(parentNode, text);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      spend();
      a.insertTextBefore(parentNode, text, referenceNode);
    },
  };
}

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
};

/** The parsed masked copy, or null when a hard limit or a parse5 throw refuses the file. */
function parseMasked(content: string): Parsed | null {
  const masked = maskedHtml(content);
  if (tooManyTags(masked)) return null;
  let doc: DefaultTreeAdapterMap["document"];
  try {
    doc = parse(masked, { sourceCodeLocationInfo: true, treeAdapter: countingAdapter() });
  } catch (err) {
    logger.warn("Span cross-check refused a file: parse5 did not finish", {
      cause: err instanceof NodeBudgetSpent ? "NODE_BUDGET" : "PARSE_ERROR",
      length: content.length,
    });
    return null;
  }
  const elements: Parsed["elements"] = new Map();
  const texts: Array<[number, number]> = [];
  // Iterative walk (deep documents must not overflow the stack).
  const stack: Array<{ node: Node; inert: boolean; textOk: boolean }> = [
    { node: doc, inert: false, textOk: true },
  ];
  while (stack.length > 0) {
    const { node, inert, textOk } = stack.pop() as { node: Node; inert: boolean; textOk: boolean };
    const loc = "sourceCodeLocation" in node ? node.sourceCodeLocation : null;
    if (node.nodeName === "#text") {
      if (loc && textOk && !inert) texts.push([loc.startOffset, loc.endOffset]);
      continue;
    }
    if (!("childNodes" in node)) continue;
    let childInert = inert;
    let childTextOk = textOk;
    if ("tagName" in node) {
      const el = node as Element;
      const eloc = el.sourceCodeLocation;
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
  return { elements, texts };
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

/** Whether [s, e) lies inside one allowed, located text node (X6: nothing else). */
function liquidSpanOk(p: Parsed, s: number, e: number): boolean {
  const k = lastStartingAtOrBefore(p.texts, s);
  return k !== -1 && e <= p.texts[k][1];
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
