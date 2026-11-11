/**
 * Exact removal spans for the clean-copy fix (gc-tib slice 1).
 *
 * Given where a detector matched, return the [start, end) range of the WHOLE
 * element to delete, or a refusal when the boundaries are not certain. Only
 * the four v1 fixable types have spans (spike D3):
 *   - GHOST_SCRIPT      `<script src=...>` through its `</script>`
 *   - GHOST_STYLE       `<link rel="stylesheet" ...>` (void element)
 *   - GHOST_PRECONNECT  `<link rel="preconnect|dns-prefetch|preload" ...>`
 *   - GHOST_SNIPPET     `{% render 'x' ... %}` / `{% include %}` tag, or one bare
 *                       `render 'x'` line inside a `{% liquid %}` block
 *
 * Offsets are UTF-16 code-unit offsets into `content`, the same unit the
 * detectors use. Every rule refuses rather than guesses: a wrong span would
 * delete live code from the merchant's theme copy.
 *
 * Pure, client-safe module (no .server suffix, no imports).
 */

export type RemovalSpan = { start: number; end: number };

export type SpanRefusal =
  /** The text at the offset is not the expected element opener. */
  | "NOT_AT_ELEMENT"
  /** The opening tag never closes, or its quotes/Liquid delimiters are unbalanced. */
  | "MALFORMED_TAG"
  /** A Liquid tag (`{% ... %}`) sits inside the HTML tag; boundaries are not certain. */
  | "LIQUID_TAG_IN_ELEMENT"
  /** `<script ... />`: the browser treats it as an open tag, so there is no element end. */
  | "SELF_CLOSING_SCRIPT"
  /** Non-whitespace between `<script src>` and `</script>`, or no `</script>`. */
  | "SCRIPT_BODY_NOT_EMPTY"
  /** A `{% render %}` tag with no closing `%}`, or another tag opens inside it. */
  | "UNTERMINATED_LIQUID_TAG"
  /** A bare `render` line that is not inside a `{% liquid %}` block. */
  | "NOT_IN_LIQUID_BLOCK"
  /** A bare `render` line that also closes the `{% liquid %}` block or opens another tag. */
  | "LIQUID_STATEMENT_SHARES_LINE"
  /** The element is inside a comment, raw/schema/javascript/stylesheet block, or another script/style body. */
  | "IN_NON_CODE_REGION"
  /** The finding type is not in the v1 fixable allowlist. */
  | "NOT_FIXABLE_TYPE";

export type SpanResult = { ok: true; span: RemovalSpan } | { ok: false; reason: SpanRefusal };

export type FixableFindingType =
  | "GHOST_SCRIPT"
  | "GHOST_STYLE"
  | "GHOST_PRECONNECT"
  | "GHOST_SNIPPET";

/** The v1 fixable allowlist (spike D3). Guarded by a test against finding-safety. */
export const FIXABLE_FINDING_TYPES: readonly FixableFindingType[] = [
  "GHOST_SCRIPT",
  "GHOST_STYLE",
  "GHOST_PRECONNECT",
  "GHOST_SNIPPET",
];

const refuse = (reason: SpanRefusal): SpanResult => ({ ok: false, reason });

/** ASCII-only case-insensitive prefix test (full-width lookalikes never match). */
function startsWithAsciiCI(content: string, at: number, lowerNeedle: string): boolean {
  if (at < 0 || at + lowerNeedle.length > content.length) return false;
  for (let i = 0; i < lowerNeedle.length; i++) {
    let c = content.charCodeAt(at + i);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lowerNeedle.charCodeAt(i)) return false;
  }
  return true;
}

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Validate an HTML opening tag starting at `start` (`<script` / `<link`) and
 * return the offset of its closing `>`. Quotes must balance, Liquid output
 * `{{ }}` must pair up inside the tag, and no Liquid tag or second `<` may
 * appear. A `>` inside a quoted value or `{{ }}` is followed correctly (the
 * scan skips quoted and Liquid-output text), so the end is the real tag end.
 */
function openTagEnd(content: string, start: number, nameLength: number): number | SpanRefusal {
  let quote: string | null = null;
  for (let i = start + 1 + nameLength; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "{" && content[i + 1] === "%") return "LIQUID_TAG_IN_ELEMENT";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
    else if (ch === "<") return "MALFORMED_TAG";
    else if (ch === "{" && content[i + 1] === "%") return "LIQUID_TAG_IN_ELEMENT";
    else if (ch === "{" && content[i + 1] === "{") {
      const close = content.indexOf("}}", i + 2);
      if (close === -1) return "MALFORMED_TAG";
      const inner = content.slice(i + 2, close);
      if (inner.includes("{{") || inner.includes("{%")) return "MALFORMED_TAG";
      i = close + 1;
    }
  }
  return "MALFORMED_TAG";
}

/** Span of `<script ...></script>` (only whitespace allowed between). */
export function scriptElementSpan(content: string, start: number): SpanResult {
  if (!startsWithAsciiCI(content, start, "<script") || !isWs(content[start + 7])) {
    return refuse("NOT_AT_ELEMENT");
  }
  const gt = openTagEnd(content, start, 6);
  if (typeof gt === "string") return refuse(gt);
  if (content[gt - 1] === "/") return refuse("SELF_CLOSING_SCRIPT");
  let i = gt + 1;
  while (i < content.length && isWs(content[i])) i++;
  if (!startsWithAsciiCI(content, i, "</script")) return refuse("SCRIPT_BODY_NOT_EMPTY");
  let j = i + 8;
  while (j < content.length && isWs(content[j])) j++;
  if (content[j] !== ">") return refuse("MALFORMED_TAG");
  return { ok: true, span: { start, end: j + 1 } };
}

/** Span of a void `<link ...>` / `<link .../>` element. */
export function linkElementSpan(content: string, start: number): SpanResult {
  if (!startsWithAsciiCI(content, start, "<link") || !isWs(content[start + 5])) {
    return refuse("NOT_AT_ELEMENT");
  }
  const gt = openTagEnd(content, start, 4);
  if (typeof gt === "string") return refuse(gt);
  return { ok: true, span: { start, end: gt + 1 } };
}

/**
 * End offset (exclusive) of a Liquid tag `{% ... %}` that starts at `start`,
 * scanning quote-aware. Refuses if another `{%`/`{{` opens first.
 */
function liquidTagEnd(content: string, start: number): number | null {
  let quote: string | null = null;
  for (let i = start + 2; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "%" && content[i + 1] === "}") return i + 2;
    else if (ch === "{" && (content[i + 1] === "%" || content[i + 1] === "{")) return null;
  }
  return null;
}

const RENDER_TAG_HEAD = /^\{%-?\s*(?:render|include)\s+["']/i;

/** Span of a `{% render 'x' ... %}` / `{%- include "x" -%}` tag. */
export function liquidRenderTagSpan(content: string, start: number): SpanResult {
  if (!RENDER_TAG_HEAD.test(content.slice(start, start + 64))) return refuse("NOT_AT_ELEMENT");
  const end = liquidTagEnd(content, start);
  if (end === null) return refuse("UNTERMINATED_LIQUID_TAG");
  return { ok: true, span: { start, end } };
}

const LIQUID_BLOCK_OPEN = /\{%-?\s*liquid\b/gi;
const BARE_RENDER_LINE = /^[ \t]*(?:render|include)\s+["']/i;

/**
 * Span of one bare `render 'x'` statement line inside `{% liquid %}`: from the
 * line start (`lineStart`, as RENDER_LIQUID_BLOCK_RE reports it) to the end of
 * the line, newline excluded. The splice engine then drops the emptied line.
 */
export function bareLiquidStatementSpan(content: string, lineStart: number): SpanResult {
  if (lineStart > 0 && content[lineStart - 1] !== "\n") return refuse("NOT_AT_ELEMENT");
  let lineEnd = content.indexOf("\n", lineStart);
  if (lineEnd === -1) lineEnd = content.length;
  if (lineEnd > lineStart && content[lineEnd - 1] === "\r") lineEnd--;
  const line = content.slice(lineStart, lineEnd);
  if (!BARE_RENDER_LINE.test(line)) return refuse("NOT_AT_ELEMENT");

  // Quote-aware: the statement must not close the block or open another tag.
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (
      (ch === "%" && line[i + 1] === "}") ||
      (ch === "{" && /[%{]/.test(line[i + 1] ?? ""))
    ) {
      return refuse("LIQUID_STATEMENT_SHARES_LINE");
    }
  }
  if (quote) return refuse("LIQUID_STATEMENT_SHARES_LINE");

  // Inside a {% liquid %} block that opened on an earlier line.
  LIQUID_BLOCK_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let inside = false;
  while ((m = LIQUID_BLOCK_OPEN.exec(content)) !== null && m.index < lineStart) {
    const end = liquidTagEnd(content, m.index);
    if (end === null || end > lineStart) {
      inside = end !== null && content.lastIndexOf("\n", lineStart - 1) >= m.index;
      break;
    }
    LIQUID_BLOCK_OPEN.lastIndex = end;
  }
  if (!inside) return refuse("NOT_IN_LIQUID_BLOCK");
  return { ok: true, span: { start: lineStart, end: lineEnd } };
}

/**
 * [start, end) ranges where markup is not live code: Liquid comment, doc, raw,
 * schema, javascript and stylesheet blocks; `{%# %}` inline comments; HTML
 * comments; and the bodies of `<script>` / `<style>` elements (so a
 * `document.write('<script src=...')` string is never treated as an element).
 * One left-to-right pass; an unterminated region runs to the end of the file.
 */
export function nonCodeRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const token =
    /\{%-?\s*(comment|doc|raw|schema|javascript|stylesheet)\s*-?%\}|\{%-?\s*#|<!--|<(script|style)(?=[\s>/])/gi;
  let m: RegExpExecArray | null;
  while ((m = token.exec(content)) !== null) {
    const at = m.index;
    let end: number;
    if (m[1]) {
      const close = new RegExp(`\\{%-?\\s*end${m[1].toLowerCase()}\\s*-?%\\}`, "gi");
      close.lastIndex = at + m[0].length;
      const c = close.exec(content);
      end = c ? c.index + c[0].length : content.length;
      ranges.push([at, end]);
    } else if (m[0].startsWith("<!--")) {
      const c = content.indexOf("-->", at + 4);
      end = c === -1 ? content.length : c + 3;
      ranges.push([at, end]);
    } else if (m[2]) {
      // Element body only: the tag itself is code (it may be the fix target).
      const gt = content.indexOf(">", at);
      if (gt === -1) break;
      const name = m[2].toLowerCase();
      const close = new RegExp(`</${name}`, "gi");
      close.lastIndex = gt + 1;
      const c = close.exec(content);
      end = c ? c.index : content.length;
      if (end > gt + 1) ranges.push([gt + 1, end]);
    } else {
      // {%# inline comment %}
      const c = content.indexOf("%}", at + 2);
      end = c === -1 ? content.length : c + 2;
      ranges.push([at, end]);
    }
    token.lastIndex = Math.max(end, at + 1);
  }
  return ranges;
}

/** Whether `offset` falls inside any [start, end) range (ranges sorted, non-overlapping). */
export function inRanges(ranges: ReadonlyArray<[number, number]>, offset: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (offset < s) hi = mid - 1;
    else if (offset >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * The removal span for a fixable finding whose detector matched at
 * `matchStart` (tag start for HTML/`{% %}` forms, line start for the bare form).
 */
export function removalSpanFor(
  findingType: FixableFindingType | string,
  content: string,
  matchStart: number,
  ranges: ReadonlyArray<[number, number]> = nonCodeRanges(content),
): SpanResult {
  if (inRanges(ranges, matchStart)) return refuse("IN_NON_CODE_REGION");
  switch (findingType) {
    case "GHOST_SCRIPT":
      return scriptElementSpan(content, matchStart);
    case "GHOST_STYLE":
    case "GHOST_PRECONNECT":
      return linkElementSpan(content, matchStart);
    case "GHOST_SNIPPET":
      return content[matchStart] === "{"
        ? liquidRenderTagSpan(content, matchStart)
        : bareLiquidStatementSpan(content, matchStart);
    default:
      // Runtime guard: callers pass stored enum strings, so an unknown type
      // must refuse, never fall through to undefined.
      return refuse("NOT_FIXABLE_TYPE");
  }
}
