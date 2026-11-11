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
  | "NOT_FIXABLE_TYPE"
  /** The element would be longer than MAX_SPAN_CHARS: not a plain app tag. */
  | "SPAN_TOO_LONG";

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

/**
 * Longest span we will ever remove. A real app tag is a few hundred chars;
 * anything longer is refused, and every boundary scan stops here, so locating
 * one span is O(MAX_SPAN_CHARS) whatever the file holds.
 */
export const MAX_SPAN_CHARS = 2048;

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
 * return the offset of its closing `>`. Quotes must balance, and a quoted
 * value may not hold `<` or a line break (an unbalanced quote would otherwise
 * swallow the markup after the tag). Liquid output `{{ }}` must pair up inside
 * the tag, and no Liquid tag or second `<` may appear. A `>` inside a quoted
 * value or `{{ }}` is skipped, so the end is the real tag end. Never scans
 * past MAX_SPAN_CHARS.
 */
function openTagEnd(content: string, start: number, nameLength: number): number | SpanRefusal {
  const limit = Math.min(content.length, start + MAX_SPAN_CHARS);
  let quote: string | null = null;
  for (let i = start + 1 + nameLength; i < limit; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "<" || ch === "\n" || ch === "\r") return "MALFORMED_TAG";
      else if (ch === "{" && content[i + 1] === "%") return "LIQUID_TAG_IN_ELEMENT";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
    else if (ch === "<") return "MALFORMED_TAG";
    else if (ch === "{" && content[i + 1] === "%") return "LIQUID_TAG_IN_ELEMENT";
    else if (ch === "{" && content[i + 1] === "{") {
      const close = content.indexOf("}}", i + 2);
      if (close === -1 || close >= limit)
        return limit < content.length ? "SPAN_TOO_LONG" : "MALFORMED_TAG";
      const inner = content.slice(i + 2, close);
      if (inner.includes("{{") || inner.includes("{%")) return "MALFORMED_TAG";
      i = close + 1;
    }
  }
  return limit < content.length ? "SPAN_TOO_LONG" : "MALFORMED_TAG";
}

/** Span of `<script ...></script>` (only whitespace allowed between). */
export function scriptElementSpan(content: string, start: number): SpanResult {
  if (!startsWithAsciiCI(content, start, "<script") || !isWs(content[start + 7])) {
    return refuse("NOT_AT_ELEMENT");
  }
  const gt = openTagEnd(content, start, 6);
  if (typeof gt === "string") return refuse(gt);
  if (content[gt - 1] === "/") return refuse("SELF_CLOSING_SCRIPT");
  const limit = Math.min(content.length, start + MAX_SPAN_CHARS);
  let i = gt + 1;
  while (i < limit && isWs(content[i])) i++;
  if (i >= limit && limit < content.length) return refuse("SPAN_TOO_LONG");
  if (!startsWithAsciiCI(content, i, "</script")) return refuse("SCRIPT_BODY_NOT_EMPTY");
  let j = i + 8;
  while (j < limit && isWs(content[j])) j++;
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
 * End offset (exclusive) of the Liquid tag `{% ... %}` that starts at `start`,
 * with Liquid's own rule: a tag ends at the FIRST `%}`, quotes or not (the
 * tokenizer is not quote-aware). Null (refuse) when a `{%` or `{{` opens
 * before that, when the tag text holds an odd number of `'` or `"` (a quote
 * that does not close inside the tag), or when no `%}` follows within
 * `maxLength` chars.
 */
function liquidTagEnd(content: string, start: number, maxLength = Infinity): number | null {
  const close = content.indexOf("%}", start + 2);
  if (close === -1 || close + 2 - start > maxLength) return null;
  const inner = content.slice(start + 2, close);
  if (inner.includes("{%") || inner.includes("{{")) return null;
  if (count(inner, "'") % 2 !== 0 || count(inner, '"') % 2 !== 0) return null;
  return close + 2;
}

function count(text: string, ch: string): number {
  let n = 0;
  for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) n++;
  return n;
}

const RENDER_TAG_HEAD = /^\{%-?\s*(?:render|include)\s+["']/i;

/** Span of a `{% render 'x' ... %}` / `{%- include "x" -%}` tag. */
export function liquidRenderTagSpan(content: string, start: number): SpanResult {
  if (!RENDER_TAG_HEAD.test(content.slice(start, start + 64))) return refuse("NOT_AT_ELEMENT");
  const end = liquidTagEnd(content, start, MAX_SPAN_CHARS);
  if (end === null) return refuse("UNTERMINATED_LIQUID_TAG");
  return { ok: true, span: { start, end } };
}

const LIQUID_BLOCK_OPEN = /\{%-?\s*liquid\b/gi;
const BARE_RENDER_LINE = /^[ \t]*(?:render|include)\s+["']/i;

/**
 * Every `{% liquid %}` block in the file, in order, as [start, end) with the
 * same first-`%}` rule as liquidTagEnd. An unterminated (or unbalanced) block
 * ends the list with end = Infinity: nothing after it is certain. One linear
 * pass; compute once per file and pass to bareLiquidStatementSpan.
 */
export function liquidBlockRanges(content: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  LIQUID_BLOCK_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIQUID_BLOCK_OPEN.exec(content)) !== null) {
    const end = liquidTagEnd(content, m.index);
    if (end === null) {
      blocks.push([m.index, Infinity]);
      break;
    }
    blocks.push([m.index, end]);
    LIQUID_BLOCK_OPEN.lastIndex = end;
  }
  return blocks;
}

/**
 * Span of one bare `render 'x'` statement line inside `{% liquid %}`: from the
 * line start (`lineStart`, as RENDER_LIQUID_BLOCK_RE reports it) to the end of
 * the line, newline excluded. The splice engine then drops the emptied line.
 */
export function bareLiquidStatementSpan(
  content: string,
  lineStart: number,
  blocks: ReadonlyArray<[number, number]> = liquidBlockRanges(content),
): SpanResult {
  if (lineStart > 0 && content[lineStart - 1] !== "\n") return refuse("NOT_AT_ELEMENT");
  let lineEnd = content.indexOf("\n", lineStart);
  if (lineEnd === -1) lineEnd = content.length;
  if (lineEnd > lineStart && content[lineEnd - 1] === "\r") lineEnd--;
  if (lineEnd - lineStart > MAX_SPAN_CHARS) return refuse("SPAN_TOO_LONG");
  const line = content.slice(lineStart, lineEnd);
  if (!BARE_RENDER_LINE.test(line)) return refuse("NOT_AT_ELEMENT");

  // The statement must not close the block or open another tag (Liquid ends
  // the block at the first `%}`, even inside quotes), and its quotes balance.
  if (line.includes("%}") || line.includes("{%") || line.includes("{{")) {
    return refuse("LIQUID_STATEMENT_SHARES_LINE");
  }
  if (count(line, "'") % 2 !== 0 || count(line, '"') % 2 !== 0) {
    return refuse("LIQUID_STATEMENT_SHARES_LINE");
  }

  // Inside a {% liquid %} block that opened on an earlier line.
  const block = lastBlockBefore(blocks, lineStart);
  const inside =
    block !== null &&
    block[1] !== Infinity &&
    block[1] > lineStart &&
    content.lastIndexOf("\n", lineStart - 1) >= block[0];
  if (!inside) return refuse("NOT_IN_LIQUID_BLOCK");
  return { ok: true, span: { start: lineStart, end: lineEnd } };
}

/** The last block starting before `offset` (blocks sorted), or null. */
function lastBlockBefore(
  blocks: ReadonlyArray<[number, number]>,
  offset: number,
): [number, number] | null {
  let lo = 0;
  let hi = blocks.length - 1;
  let found: [number, number] | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid][0] < offset) {
      found = blocks[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** HTML whitespace (tab, LF, FF, CR, space); NBSP and \v are not. */
function isHtmlWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
}

/** A Liquid tag whose body is not code (sticky: tested at an exact offset). */
const LIQUID_BLOCK_OPENER =
  /\{%-?\s*(?:(?:comment|doc)\b[^%]*|raw|schema|javascript|stylesheet)\s*-?%\}|\{%-?\s*#/iy;

function isLiquidBlockOpener(content: string, at: number): boolean {
  LIQUID_BLOCK_OPENER.lastIndex = at;
  return LIQUID_BLOCK_OPENER.test(content);
}

/**
 * Walk an HTML start or end tag from just after `<name` (or `</name`) to just
 * past its `>`. The caller marks the whole interior as text (attribute values
 * included); the walk only finds the real `>` (quoted or unquoted values,
 * Liquid skipped as a unit).
 *
 * Hard limit (gc-tib.11 audit r2): the walk does not try to model every way
 * HTML and Liquid can interleave. A tag is AMBIGUOUS, and the caller then
 * treats everything from the tag to the end of the file as text, when it
 * holds a Liquid block opener (`{% comment %}`, `{% raw %}`, `{%#`...), a `<`
 * outside a value, a quote that doesn't follow `=`, or when the tag, a value
 * or a Liquid tag in it never closes. An unquoted value runs to whitespace or
 * `>` and takes quotes and `<` with it, as in HTML.
 * Ordinary markup (`class="{% if x %}a{% endif %}"`, `value={{ id }}`,
 * `{% if x %}hidden{% endif %}`) is not ambiguous.
 */
function walkTag(content: string, from: number): { end: number } | null {
  const len = content.length;
  let mode: "none" | "quoted" | "unquoted" = "none";
  let quote = "";
  let afterEq = false;
  let i = from;
  while (i < len) {
    const ch = content[i];
    if (ch === "{" && (content[i + 1] === "{" || content[i + 1] === "%")) {
      if (content[i + 1] === "%" && isLiquidBlockOpener(content, i)) return null;
      const close = content.indexOf(content[i + 1] === "{" ? "}}" : "%}", i + 2);
      if (close === -1) return null;
      if (mode === "none" && afterEq) {
        // Liquid right after `=` starts an unquoted value (`value={{ id }}`).
        afterEq = false;
        mode = "unquoted";
      }
      i = close + 2;
      continue;
    }
    if (mode === "quoted") {
      if (ch === quote) mode = "none";
    } else if (mode === "unquoted") {
      if (isHtmlWs(ch) || ch === ">") {
        mode = "none";
        if (ch === ">") return { end: i + 1 };
      }
      // Anything else, quotes and `<` included, is part of the value (HTML).
    } else if (isHtmlWs(ch)) {
      // Whitespace keeps `afterEq` (`a = "b"` is a value).
    } else if (afterEq) {
      afterEq = false;
      if (ch === '"' || ch === "'") {
        mode = "quoted";
        quote = ch;
      } else if (ch === ">") {
        return { end: i + 1 };
      } else if (ch === "<") {
        return null;
      } else {
        mode = "unquoted";
      }
    } else if (ch === "=") {
      afterEq = true;
    } else if (ch === ">") {
      return { end: i + 1 };
    } else if (ch === "<" || ch === '"' || ch === "'") {
      return null;
    }
    i++;
  }
  return null;
}

/** Elements whose body is text up to their own close tag. */
const BODY_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "template",
  "xmp",
  "noscript",
  "iframe",
  "noembed",
  "noframes",
]);

/**
 * Where a text-only element's body ends: at `</name` followed by whitespace,
 * `/` or `>` (so `</scriptx` doesn't end a script). In a script, a `<!--`
 * followed by `<script` before that close (the HTML "double escaped" state)
 * makes the body run to the first close tag after the next `-->`
 * (conservative). A plain `<!--` doesn't: `</script` ends an escaped script.
 * Only the body itself is searched, so many elements stay linear (audit r3).
 */
function bodyEnd(content: string, name: string, from: number): number {
  const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
  close.lastIndex = from;
  let c = close.exec(content);
  if (name === "script") {
    const body = content.slice(from, c ? c.index : content.length);
    const open = body.indexOf("<!--");
    if (open !== -1 && /<script[\\t\\n\\f\\r />]/i.test(body.slice(open + 4))) {
      const shut = content.indexOf("-->", from + open + 4);
      if (shut === -1) return content.length;
      close.lastIndex = shut + 3;
      c = close.exec(content);
    }
  }
  return c ? c.index : content.length;
}

const LIQUID_TAG_HEAD = /^\{%-?\s*liquid\b/i;

/**
 * The text inside one Liquid tag or output that starts at `at` (`{%` or
 * `{{`): its string literals. Liquid ends the tag at the first `%}` / `}}`,
 * even inside quotes, so a literal that doesn't close by then runs to the tag
 * end. In a `{% liquid %}` tag, statements are lines (the first one follows
 * `liquid`); `#` lines and lines inside `comment`/`doc` blocks (nested,
 * counted by depth) are text, and their quotes don't pair with real strings.
 * Returns the tag end, or the file end when the tag never closes (then the
 * rest of the file from inside the tag is one range; the tag's own start
 * keeps its specific refusal).
 */
function liquidTagLiterals(content: string, at: number, ranges: Array<[number, number]>): number {
  const closer = content[at + 1] === "{" ? "}}" : "%}";
  const close = content.indexOf(closer, at + 2);
  if (close === -1) {
    if (at + 2 < content.length) ranges.push([at + 2, content.length]);
    return content.length;
  }
  const strings = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const ch = content[i];
      if (ch === '"' || ch === "'") {
        const q = content.indexOf(ch, i + 1);
        const end = q === -1 || q >= close ? close : q + 1;
        ranges.push([i, end]);
        i = end;
      } else i++;
    }
    return i;
  };
  const head = closer === "%}" ? LIQUID_TAG_HEAD.exec(content.slice(at, at + 32)) : null;
  if (!head) {
    strings(at + 2, close);
    return close + 2;
  }
  let depth = 0;
  let lineStart = at + head[0].length;
  while (lineStart < close) {
    let eol = content.indexOf("\n", lineStart);
    if (eol === -1 || eol > close) eol = close;
    const stmt = content.slice(lineStart, eol).trim();
    const word = (stmt.split(/\s+/)[0] ?? "").toLowerCase();
    if (word === "comment" || word === "doc") depth++;
    const text = depth > 0 || stmt.startsWith("#");
    if ((word === "endcomment" || word === "enddoc") && depth > 0) depth--;
    if (text) {
      if (eol > lineStart) ranges.push([lineStart, eol]);
      lineStart = eol + 1;
    } else {
      // A string that runs past the line end runs to the tag end.
      lineStart = Math.max(strings(lineStart, eol), eol) + 1;
    }
  }
  return close + 2;
}

/**
 * [start, end) ranges where markup is not live code: Liquid comment, doc, raw,
 * schema, javascript and stylesheet blocks; `{%# %}` inline comments; HTML
 * comments and bogus comments (`<!x`, `<?x`, `</` + non-letter, to the next
 * `>`); the bodies of text-only elements (`<script>`, `<style>`, `<textarea>`,
 * `<title>`, `<template>`, `<xmp>`, `<noscript>`, `<iframe>`, `<noembed>`,
 * `<noframes>`; `<plaintext>` runs to the end of the file); string literals
 * inside other Liquid tags and outputs, and comment lines in `{% liquid %}`;
 * the interior of every HTML tag (name, attributes, values: a span starts only
 * at a real tag's `<`). An ambiguous tag (see walkTag) makes the rest of the
 * file text: a hard limit, not a guess.
 * One left-to-right pass; an unterminated region runs to the end of the file.
 * The result is sorted and non-overlapping (inRanges relies on it).
 */
export function nonCodeRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const len = content.length;
  const token =
    /\{%-?\s*((?:comment|doc)\b[^%]*?|raw|schema|javascript|stylesheet)\s*-?%\}|\{%-?\s*#|<!--|<[!?]|<\/(?![a-zA-Z])|\{[{%]|<(\/?)([a-zA-Z][^\t\n\f\r />]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = token.exec(content)) !== null) {
    const at = m.index;
    let end: number;
    if (m[1]) {
      const kind = m[1].trim().split(/\s+/)[0].toLowerCase();
      // comment and doc nest (Liquid 5.4+): count depth to the matching end.
      const nests = kind === "comment" || kind === "doc";
      const tagRe = new RegExp(
        nests ? `\\{%-?\\s*(end)?${kind}\\b[^%]*?-?%\\}` : `\\{%-?\\s*(end)${kind}\\s*-?%\\}`,
        "gi",
      );
      tagRe.lastIndex = at + m[0].length;
      let depth = 1;
      end = len;
      let c: RegExpExecArray | null;
      while ((c = tagRe.exec(content)) !== null) {
        depth += c[1] ? -1 : 1;
        if (depth === 0) {
          end = c.index + c[0].length;
          break;
        }
      }
      ranges.push([at, end]);
    } else if (m[0] === "<!--") {
      const c = content.indexOf("-->", at + 4);
      end = c === -1 ? len : c + 3;
      ranges.push([at, end]);
    } else if (m[0] === "<!" || m[0] === "<?" || m[0] === "</") {
      // Bogus comment: to the next `>`.
      const c = content.indexOf(">", at + 2);
      end = c === -1 ? len : c + 1;
      ranges.push([at, end]);
    } else if (m[3] !== undefined) {
      const isEnd = m[2] === "/";
      const name = m[3].toLowerCase();
      const tag = walkTag(content, at + m[0].length);
      if (tag === null) {
        // Ambiguous tag: nothing from here on is certain.
        ranges.push([at, len]);
        break;
      }
      // The tag's interior (name, attributes, Liquid, up to its '>') is never
      // a fix target: a span may start only at a real tag's '<' (audit r3:
      // '<div<link ...>' is one tag, not a link). Values lie inside it.
      // (No spread: a tag with 100k+ values would overflow the stack.)
      if (tag.end > at + 1) ranges.push([at + 1, tag.end]);
      end = tag.end;
      if (!isEnd && name === "plaintext") {
        if (end < len) ranges.push([end, len]);
        end = len;
      } else if (!isEnd && BODY_ELEMENTS.has(name) && end < len) {
        const bodyStart = end;
        end = bodyEnd(content, name, bodyStart);
        if (end > bodyStart) ranges.push([bodyStart, end]);
      }
    } else if (m[0] === "{{" || m[0] === "{%") {
      end = liquidTagLiterals(content, at, ranges);
    } else {
      // {%# inline comment %}
      const c = content.indexOf("%}", at + 2);
      end = c === -1 ? len : c + 2;
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
  /** liquidBlockRanges(content), computed once per file by callers that locate many spans. */
  blocks?: ReadonlyArray<[number, number]>,
): SpanResult {
  if (inRanges(ranges, matchStart)) return refuse("IN_NON_CODE_REGION");
  let result: SpanResult;
  switch (findingType) {
    case "GHOST_SCRIPT":
      result = scriptElementSpan(content, matchStart);
      break;
    case "GHOST_STYLE":
    case "GHOST_PRECONNECT":
      result = linkElementSpan(content, matchStart);
      break;
    case "GHOST_SNIPPET":
      result =
        content[matchStart] === "{"
          ? liquidRenderTagSpan(content, matchStart)
          : bareLiquidStatementSpan(content, matchStart, blocks);
      break;
    default:
      // Runtime guard: callers pass stored enum strings, so an unknown type
      // must refuse, never fall through to undefined.
      return refuse("NOT_FIXABLE_TYPE");
  }
  if (result.ok && result.span.end - result.span.start > MAX_SPAN_CHARS) {
    return refuse("SPAN_TOO_LONG");
  }
  return result;
}
