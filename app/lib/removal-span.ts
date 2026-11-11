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
 * Where a span may start is decided by nonCodeRanges (gc-t44r): Liquid is
 * mapped first, then HTML is tokenized on a copy with Liquid masked, and any
 * structure that depends on how Liquid renders makes the rest of the file
 * non-code. Residual risks (not modeled, by design):
 *   - Liquid variables, filters, `{% render %}` / `{% include %}` /
 *     `{% section %}` output and snippet `break`s are unknown text at scan
 *     time: they can emit markup (`<!--`, quotes, `>`) that changes the HTML
 *     structure. Only string literals in `{{ }}`, echo and cycle are checked.
 *   - Tree-construction quirks beyond the tokenizer are approximated: inside
 *     svg/math/select (tracked by start/end tag pairs) a text-only body must
 *     hold no '<'; other insertion modes are assumed to be "in body".
 *   - Liquid itself is modeled from Shopify Liquid's tokenizer rules; a
 *     template Shopify would reject (unknown or upper-case tag, mismatched
 *     block) is treated as ambiguous, not parsed.
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

/* ------------------------------------------------------------------------- *
 * Non-code ranges (gc-t44r redesign).
 *
 * Liquid renders before the browser parses HTML, so the scan runs in two
 * phases. Phase 1 maps the Liquid on the raw text. Phase 2 tokenizes HTML on
 * a copy where every Liquid token is replaced by a filler char. Every rule is
 * a hard limit: when the HTML structure would depend on how Liquid renders,
 * everything from that point to the end of the file is non-code.
 * ------------------------------------------------------------------------- */

/** Token kinds. */
const K_EMIT = 0; // may render text: {{ }}, echo, render, unknown tags...
const K_SILENT = 1; // renders nothing: assign, comments, raw delimiters...
const K_OPEN = 2; // control-flow block opener
const K_BRANCH = 3; // else / elsif / when
const K_CLOSE = 4; // end of a control-flow block
const K_STYLE_OPEN = 5; // {% style %}: renders <style data-shopify>
const K_STYLE_CLOSE = 6; // {% endstyle %}: renders </style>

/** Token flags. F_LIT_* = a string literal this token emits holds the char. */
const F_LIT_LTGT = 1; // < or >
const F_LIT_DQ = 2; // "
const F_LIT_SQ = 4; // '
const F_LIT_EQWS = 8; // = or whitespace
const F_LIT_DASH = 16; // - or !
const F_LIT_BRACKET = 32; // ]
const F_LSTRIP = 64; // {%- / {{-
const F_RSTRIP = 128; // -%} / -}}
const F_LOOP = 256; // for / tablerow (opener or closer)
const F_MARKUP = 512; // form / tablerow: the tag itself emits HTML tags
const F_CONTROL = 1024; // any control-flow tag (removalSpanFor refuses spans holding one)
const F_LIQUID_TAG = 2048; // {% liquid %}

/** Blocks whose body renders conditionally, repeatedly or not at all. */
const CONTROL_BLOCKS = new Set([
  "if",
  "unless",
  "case",
  "for",
  "tablerow",
  "capture",
  "form",
  "paginate",
  "ifchanged",
]);
const BRANCH_PARENTS = new Map<string, readonly string[]>([
  ["else", ["if", "unless", "case", "for"]],
  ["elsif", ["if", "unless"]],
  ["when", ["case"]],
]);
/** Liquid blocks whose body is not parsed as Liquid. */
const RAW_BLOCKS = new Set(["raw", "schema", "javascript", "stylesheet"]);

/**
 * Element names that change how the HTML tokenizer reads what follows (text
 * bodies, nested template content, foreign/select content). Liquid that may
 * complete one of these names is ambiguous.
 */
const DANGER_NAMES = [
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
  "plaintext",
  "svg",
  "math",
  "select",
];
/** Elements whose body is text up to their own end tag. */
const BODY_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "noscript",
  "iframe",
  "noembed",
  "noframes",
]);
/** Elements inside which raw-text rules may not apply (foreign content, select). */
const STRICT_ELEMENTS = new Set(["svg", "math", "select"]);

const FILL = "x";
const EFF = 16;
const TAG_NAME = /\{%-?[ \t\n\r\f\v]*(#|\w+)/y;
const PATTERN_LT_NAME = /^<\/?([a-z]*)$/;
const PATTERN_LT_BANG = /^<!(?:-|\[(?:c(?:d(?:a(?:t(?:a)?)?)?)?)?)?$/;

/** TypedArray.fill, with a plain loop for the short runs that dominate. */
function fillRange(arr: Int32Array, v: number, a: number, b: number): void {
  if (b - a > 32) arr.fill(v, a, b);
  else for (let k = a; k < b; k++) arr[k] = v;
}

const fills: string[] = [];
/** FILL repeated n times (cached for short runs). */
function filler(n: number): string {
  if (n > 256) return FILL.repeat(n);
  return (fills[n] ??= FILL.repeat(n));
}

function isStripWs(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0;
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function asciiLower(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      return s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
    }
  }
  return s;
}

/** Next `{{` or `{%` at or after `from`, or -1. */
function nextLiquidOpen(content: string, from: number): number {
  for (let i = content.indexOf("{", from); i !== -1; i = content.indexOf("{", i + 1)) {
    const c = content.charCodeAt(i + 1);
    if (c === 123 || c === 37) return i;
  }
  return -1;
}

/**
 * End (exclusive) of the Liquid token at `q`, with Liquid's tokenizer: a tag
 * ends at the first `%}`, an output at the first `}`. -1: never closes.
 * -2: an output whose first `}` is not `}}` (Liquid and the spec disagree on
 * where it ends: ambiguous).
 */
function liquidTokenEnd(content: string, q: number): number {
  if (content.charCodeAt(q + 1) === 37) {
    const c = content.indexOf("%}", q + 2);
    return c === -1 ? -1 : c + 2;
  }
  const c = content.indexOf("}", q + 2);
  if (c === -1) return -1;
  return content.charCodeAt(c + 1) === 125 ? c + 2 : -2;
}

/** Tag name at `at` (`{%-? name`), or "" when there is none before `limit`. */
function tagNameAt(content: string, at: number, limit: number): { name: string; end: number } {
  TAG_NAME.lastIndex = at;
  const m = TAG_NAME.exec(content);
  if (!m || TAG_NAME.lastIndex > limit) return { name: "", end: at + 2 };
  return { name: m[1], end: TAG_NAME.lastIndex };
}

/**
 * Liquid's tag-name rule inside raw and comment bodies: a token ending in
 * `%}` is named by its LAST `{%` (Ruby `\A(.*){%-?\s*(\w+)...%}\z`, greedy).
 */
function bodyTokenName(content: string, q: number, e: number): { name: string; at: number } {
  if (content.charCodeAt(q + 1) !== 37) return { name: "", at: q };
  const k = content.lastIndexOf("{%", e - 3);
  return { name: tagNameAt(content, k, e - 2).name, at: k };
}

type BodyEnd = { bodyEnd: number; end: number } | { amb: number } | null;

/** End of a raw-like body: the first token named `endName`. null: unclosed. */
function rawBodyEnd(content: string, from: number, endName: string): BodyEnd {
  for (let q = nextLiquidOpen(content, from); q !== -1; ) {
    const e = liquidTokenEnd(content, q);
    if (e === -1) return null;
    if (e === -2) return { amb: q };
    const t = bodyTokenName(content, q, e);
    if (t.name === endName) return { bodyEnd: t.at, end: e };
    q = nextLiquidOpen(content, e);
  }
  return null;
}

/** End of a comment/doc body: nested by depth, raw bodies skipped. */
function commentBodyEnd(content: string, from: number, kind: string): BodyEnd {
  let depth = 1;
  for (let q = nextLiquidOpen(content, from); q !== -1; ) {
    const e = liquidTokenEnd(content, q);
    if (e === -1) return null;
    if (e === -2) return { amb: q };
    const t = bodyTokenName(content, q, e);
    let next = e;
    if (t.name === kind) depth++;
    else if (t.name === "end" + kind) {
      if (--depth === 0) return { bodyEnd: t.at, end: e };
    } else if (t.name === "raw") {
      const r = rawBodyEnd(content, e, "endraw");
      if (r === null || "amb" in r) return r;
      next = r.end;
    }
    q = nextLiquidOpen(content, next);
  }
  return null;
}

/** F_LIT_* flags for the chars in [a, b). */
function charFlags(content: string, a: number, b: number): number {
  let f = 0;
  for (let i = a; i < b; i++) {
    const c = content.charCodeAt(i);
    if (c === 60 || c === 62) f |= F_LIT_LTGT;
    else if (c === 34) f |= F_LIT_DQ;
    else if (c === 39) f |= F_LIT_SQ;
    else if (c === 61 || isStripWs(c)) f |= F_LIT_EQWS;
    else if (c === 45 || c === 33) f |= F_LIT_DASH;
    else if (c === 93) f |= F_LIT_BRACKET;
  }
  return f;
}

/** F_LIT_* flags of the string literals in [a, b); an unclosed one runs to b. */
function stringFlags(content: string, a: number, b: number): number {
  let f = 0;
  let i = a;
  while (i < b) {
    const c = content.charCodeAt(i);
    if (c !== 34 && c !== 39) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < b && content.charCodeAt(j) !== c) j++;
    f |= charFlags(content, i + 1, j);
    i = j + 1;
  }
  return f;
}

/**
 * The statements of one `{% liquid %}` tag (lines; the first follows
 * `liquid`). `#` lines and lines inside comment/doc (nested by depth) are
 * text. Strings end at the line end: an unclosed one makes the rest of the
 * tag text. Returns the literal flags of echo/cycle lines and whether a
 * break/continue outside the tag's own loops can stop an enclosing loop.
 */
function liquidTagLines(
  content: string,
  from: number,
  close: number,
  ranges: Array<[number, number]>,
): { flags: number; breaks: boolean } {
  let depth = 0;
  let loops = 0;
  let flags = 0;
  let breaks = false;
  let lineStart = from;
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
      continue;
    }
    if (word === "for" || word === "tablerow") loops++;
    else if ((word === "endfor" || word === "endtablerow") && loops > 0) loops--;
    else if ((word === "break" || word === "continue") && loops === 0) breaks = true;
    const emits = word === "echo" || word === "cycle";
    let i = lineStart;
    while (i < eol) {
      const c = content.charCodeAt(i);
      if (c !== 34 && c !== 39) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < eol && content.charCodeAt(j) !== c) j++;
      if (j >= eol) {
        // Unclosed at the line end: the rest of the tag is text.
        ranges.push([i, close]);
        if (emits) flags |= charFlags(content, i + 1, eol);
        return { flags, breaks };
      }
      ranges.push([i, j + 1]);
      if (emits) flags |= charFlags(content, i + 1, j);
      i = j + 1;
    }
    lineStart = eol + 1;
  }
  return { flags, breaks };
}

type Frame = { name: string; start: number; outer: number; broken: boolean };

type LiquidMap = {
  /** Phase-1 non-code ranges (unsorted). */
  ranges: Array<[number, number]>;
  /** First offset whose meaning is unknown (content.length when none). */
  ambAt: number;
  /** Where the non-code tail starts (ambAt, or ambAt + 1 for an unclosed token). */
  ambRangeAt: number;
  tStart: number[];
  tEnd: number[];
  tKind: number[];
  tFlags: number[];
  /** Char code of the last static char before the token (-1: none). */
  tEffLast: number[];
  /** Token index per offset (-1: static text). */
  tokId: Int32Array;
  /** Control-flow branch id per offset. */
  path: Int32Array;
};

/** Phase 1: Liquid tokens, text blocks, literals and branch paths. */
function liquidMap(content: string): LiquidMap {
  const len = content.length;
  const ranges: Array<[number, number]> = [];
  const tokId = new Int32Array(len).fill(-1);
  const path = new Int32Array(len);
  const tStart: number[] = [];
  const tEnd: number[] = [];
  const tKind: number[] = [];
  const tFlags: number[] = [];
  const tEffLast: number[] = [];
  let ambAt = len;
  let ambRangeAt = len;
  const amb = (at: number, rangeAt = at) => {
    ambAt = Math.min(ambAt, at);
    ambRangeAt = Math.min(ambRangeAt, rangeAt);
  };

  let curPath = 0;
  let nextPath = 1;
  const stack: Frame[] = [];

  // The static text as rendered when every token renders empty (whitespace
  // control applied): the run from its last '<' (null when longer than EFF
  // chars, or cut by a tag that renders '>'), that '<' offset, the last char.
  let ltTail: string | null = null;
  let ltPos = -1;
  let effLast = -1;
  const effAppend = (a: number, b: number, stripLead: boolean, stripTrail: boolean) => {
    if (stripLead) while (a < b && isStripWs(content.charCodeAt(a))) a++;
    if (stripTrail) while (b > a && isStripWs(content.charCodeAt(b - 1))) b--;
    if (a >= b) return;
    effLast = content.charCodeAt(b - 1);
    let k = b - 1;
    while (k >= a && content.charCodeAt(k) !== 60) k--;
    if (k >= a) {
      ltPos = k;
      ltTail = b - k <= EFF ? content.slice(k, b) : null;
    } else if (ltTail !== null) {
      ltTail = ltTail.length + (b - a) <= EFF ? ltTail + content.slice(a, b) : null;
    }
  };
  const effSynthetic = () => {
    ltTail = null;
    effLast = 62;
  };
  /** Rendered empty, a token here could complete `<name`, `</name` or `<!--`. */
  const seamAt = (): number => {
    if (ltTail === null) return -1;
    const tail = asciiLower(ltTail);
    const m = PATTERN_LT_NAME.exec(tail);
    if (m && DANGER_NAMES.some((n) => n.startsWith(m[1]))) return ltPos;
    if (PATTERN_LT_BANG.test(tail)) return ltPos;
    return -1;
  };

  const addToken = (s: number, e: number, kind: number, flags: number, p: number) => {
    const id = tStart.length;
    tStart.push(s);
    tEnd.push(e);
    tKind.push(kind);
    tFlags.push(flags);
    tEffLast.push(effLast);
    fillRange(tokId, id, s, e);
    fillRange(path, p, s, e);
    // {% style %} / {% endstyle %} render real tags: the copy shows them.
    if (kind === K_STYLE_OPEN) fillRange(tokId, -1, s, s + 7);
    if (kind === K_STYLE_CLOSE) fillRange(tokId, -1, s, s + 8);
  };
  /** break/continue: the rest of the enclosing loop body may not render. */
  const doBreak = (at: number): boolean => {
    let l = stack.length - 1;
    while (l >= 0 && stack[l].name !== "for" && stack[l].name !== "tablerow") l--;
    if (l < 0) {
      // Outside a loop, Liquid stops rendering the rest of the template.
      amb(at);
      return false;
    }
    for (let k = l; k < stack.length; k++) stack[k].broken = true;
    curPath = nextPath++;
    return true;
  };

  let pos = 0;
  let prevR = false;
  scan: for (;;) {
    const q = nextLiquidOpen(content, pos);
    if (q === -1) {
      fillRange(path, curPath, pos, len);
      break;
    }
    let e = liquidTokenEnd(content, q);
    fillRange(path, curPath, pos, q);
    if (e < 0) {
      // Unclosed: the token's own start keeps its specific refusal.
      if (e === -1) amb(q, q + 1);
      else amb(q);
      break;
    }
    const isTag = content.charCodeAt(q + 1) === 37;
    const lstrip = content.charCodeAt(q + 2) === 45;
    const rstrip = e - 3 >= q + 2 && content.charCodeAt(e - 3) === 45;
    effAppend(pos, q, prevR, lstrip);
    const seam = seamAt();
    if (seam !== -1) {
      amb(seam);
      break;
    }
    let flags = (lstrip ? F_LSTRIP : 0) | (rstrip ? F_RSTRIP : 0);

    if (!isTag) {
      flags |= stringFlags(content, q + 2, e - 2);
      if (flags & F_LIT_LTGT) {
        amb(q);
        break;
      }
      addToken(q, e, K_EMIT, flags, curPath);
      ranges.push([q + 1, e]);
      pos = e;
      prevR = rstrip;
      continue;
    }

    const { name, end: nameEnd } = tagNameAt(content, q, e - 2);
    if (name === "" || /[A-Z]/.test(name)) {
      // No name (a Liquid syntax error), or upper case: `{% COMMENT %}` is not a comment.
      amb(q);
      break;
    }

    if (name === "#") {
      addToken(q, e, K_SILENT, flags, curPath);
      ranges.push([q, e]);
    } else if (name === "comment" || name === "doc" || RAW_BLOCKS.has(name)) {
      const r =
        name === "comment" || name === "doc"
          ? commentBodyEnd(content, e, name)
          : rawBodyEnd(content, e, "end" + name);
      if (r === null || "amb" in r) {
        amb(q);
        break;
      }
      ranges.push([q, r.end]);
      const closeR = content.charCodeAt(r.end - 3) === 45;
      if (name === "raw") {
        // The raw body renders verbatim: it is HTML for phase 2.
        addToken(q, e, K_SILENT, flags, curPath);
        fillRange(path, curPath, e, r.bodyEnd);
        const closeL = content.charCodeAt(r.bodyEnd + 2) === 45;
        effAppend(e, r.bodyEnd, rstrip, closeL);
        const s2 = seamAt();
        if (s2 !== -1) {
          amb(s2);
          break;
        }
        addToken(
          r.bodyEnd,
          r.end,
          K_SILENT,
          (closeL ? F_LSTRIP : 0) | (closeR ? F_RSTRIP : 0),
          curPath,
        );
      } else {
        addToken(q, r.end, K_SILENT, (flags & ~F_RSTRIP) | (closeR ? F_RSTRIP : 0), curPath);
      }
      e = r.end;
      pos = e;
      prevR = closeR;
      continue;
    } else if (name === "liquid") {
      const info = liquidTagLines(content, nameEnd, e - 2, ranges);
      if (info.flags & F_LIT_LTGT) {
        amb(q);
        break;
      }
      addToken(q, e, K_EMIT, flags | info.flags | F_LIQUID_TAG, curPath);
      if (info.breaks && !doBreak(e)) break;
    } else if (name === "style") {
      addToken(q, e, K_STYLE_OPEN, flags, curPath);
      stack.push({ name, start: q, outer: curPath, broken: false });
      effSynthetic();
      ranges.push([q + 1, e]);
    } else if (CONTROL_BLOCKS.has(name)) {
      flags |= F_CONTROL;
      if (name === "for" || name === "tablerow") flags |= F_LOOP;
      if (name === "form" || name === "tablerow") flags |= F_MARKUP;
      addToken(q, e, K_OPEN, flags, curPath);
      stack.push({ name, start: q, outer: curPath, broken: false });
      curPath = nextPath++;
      if (flags & F_MARKUP) effSynthetic();
      ranges.push([q + 1, e]);
    } else if (BRANCH_PARENTS.has(name)) {
      const top = stack[stack.length - 1];
      if (!top || !BRANCH_PARENTS.get(name)?.includes(top.name)) {
        amb(q);
        break;
      }
      addToken(q, e, K_BRANCH, flags | F_CONTROL, top.outer);
      curPath = nextPath++;
      ranges.push([q + 1, e]);
    } else if (name.startsWith("end")) {
      const top = stack[stack.length - 1];
      if (!top || "end" + top.name !== name) {
        amb(q);
        break;
      }
      stack.pop();
      if (top.name === "style") {
        addToken(q, e, K_STYLE_CLOSE, flags, top.outer);
        ranges.push([top.start, e]);
        effSynthetic();
      } else {
        flags |= F_CONTROL;
        if (top.name === "for" || top.name === "tablerow") flags |= F_LOOP;
        if (top.name === "form" || top.name === "tablerow") flags |= F_MARKUP;
        addToken(q, e, K_CLOSE, flags, top.outer);
        if (flags & F_MARKUP) effSynthetic();
        ranges.push([q + 1, e]);
      }
      const parent = stack[stack.length - 1];
      curPath = parent && parent.broken ? nextPath++ : top.outer;
    } else if (name === "break" || name === "continue") {
      addToken(q, e, K_SILENT, flags | F_CONTROL, curPath);
      ranges.push([q + 1, e]);
      if (!doBreak(e)) break;
    } else if (name === "echo" || name === "cycle") {
      flags |= stringFlags(content, nameEnd, e - 2);
      if (flags & F_LIT_LTGT) {
        amb(q);
        break;
      }
      addToken(q, e, K_EMIT, flags, curPath);
      ranges.push([q + 1, e]);
    } else if (name === "assign" || name === "layout") {
      addToken(q, e, K_SILENT, flags, curPath);
      ranges.push([q + 1, e]);
    } else {
      // render, include, section, unknown tags...: may render anything.
      addToken(q, e, K_EMIT, flags, curPath);
      ranges.push([q + 1, e]);
    }
    pos = e;
    prevR = rstrip;
    continue scan;
  }
  // An unclosed block: Liquid refuses the template; nothing after it is certain.
  if (stack.length > 0) amb(stack[0].start);
  return { ranges, ambAt, ambRangeAt, tStart, tEnd, tKind, tFlags, tEffLast, tokId, path };
}

/* Tag-interior states (HTML tokenizer, attribute states). */
const S_TN = 0; // tag name
const S_BN = 1; // before attribute name
const S_AN = 2; // attribute name
const S_AFN = 3; // after attribute name
const S_BV = 4; // before attribute value
const S_DQ = 5; // double-quoted value
const S_SQ = 6; // single-quoted value
const S_UNQ = 7; // unquoted value
const S_AQ = 8; // after quoted value
const S_SC = 9; // self-closing start tag
const N_STATES = 10;
const END = -1;
const END_SC = -2;

/** Char classes: 0 ws, 1 '/', 2 '>', 3 '=', 4 '"', 5 "'", 6 other. */
function charClass(c: number): number {
  if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) return 0;
  if (c === 47) return 1;
  if (c === 62) return 2;
  if (c === 61) return 3;
  if (c === 34) return 4;
  if (c === 39) return 5;
  return 6;
}

/** One HTML tokenizer step in the tag states (reconsumes resolved). */
function tagStep(s: number, cls: number): number {
  switch (s) {
    case S_TN:
      return cls === 0 ? S_BN : cls === 1 ? S_SC : cls === 2 ? END : S_TN;
    case S_BN:
    case S_AFN:
      if (cls === 0) return s;
      if (cls === 1) return S_SC;
      if (cls === 2) return END;
      // `=` right after whitespace starts a name; after a name it starts a value.
      if (cls === 3) return s === S_AFN ? S_BV : S_AN;
      return S_AN;
    case S_AN:
      return cls === 0 ? S_AFN : cls === 1 ? S_SC : cls === 2 ? END : cls === 3 ? S_BV : S_AN;
    case S_BV:
      return cls === 0 ? S_BV : cls === 4 ? S_DQ : cls === 5 ? S_SQ : cls === 2 ? END : S_UNQ;
    case S_DQ:
      return cls === 4 ? S_AQ : S_DQ;
    case S_SQ:
      return cls === 5 ? S_AQ : S_SQ;
    case S_UNQ:
      return cls === 0 ? S_BN : cls === 2 ? END : S_UNQ;
    case S_AQ:
      return cls === 0 ? S_BN : cls === 1 ? S_SC : cls === 2 ? END : S_AN;
    default:
      // S_SC
      return cls === 2 ? END_SC : cls === 0 ? S_BN : cls === 1 ? S_SC : S_AN;
  }
}

/** The state a non-empty run of plain chars (a masked token) leads to. */
function fillStep(s: number): number {
  return tagStep(s, 6);
}

// State-set tables: index = set * 7 + class.
const SETS = 1 << N_STATES;
const NEXT = new Uint16Array(SETS * 7);
const ENDS = new Uint16Array(SETS * 7);
const ENDS_SC = new Uint16Array(SETS * 7);
const FILL_NEXT = new Uint16Array(SETS);
for (let set = 0; set < SETS; set++) {
  let fill = 0;
  for (let s = 0; s < N_STATES; s++) if (set & (1 << s)) fill |= 1 << fillStep(s);
  FILL_NEXT[set] = fill;
  for (let cls = 0; cls < 7; cls++) {
    let next = 0;
    let ends = 0;
    let endsSc = 0;
    for (let s = 0; s < N_STATES; s++) {
      if (!(set & (1 << s))) continue;
      const n = tagStep(s, cls);
      if (n === END || n === END_SC) {
        ends |= 1 << s;
        if (n === END_SC) endsSc |= 1 << s;
      } else next |= 1 << n;
    }
    NEXT[set * 7 + cls] = next;
    ENDS[set * 7 + cls] = ends;
    ENDS_SC[set * 7 + cls] = endsSc;
  }
}
const QUOTED = (1 << S_DQ) | (1 << S_SQ);
const NAME_STATES = (1 << S_BN) | (1 << S_AN) | (1 << S_AFN) | (1 << S_AQ) | (1 << S_SC);

/** A cached forward search: the first match at or after i (calls with rising i). */
function finder(text: string, re: RegExp): (i: number) => number {
  let at = -2;
  return (i: number) => {
    if (at !== -1 && at < i) {
      re.lastIndex = i;
      const m = re.exec(text);
      at = m ? m.index : -1;
    }
    return at;
  };
}

/** Phase 2: HTML structure on the masked copy. */
function htmlScan(
  content: string,
  map: LiquidMap,
): { ranges: Array<[number, number]>; ambAt: number } {
  const len = content.length;
  const { tStart, tEnd, tKind, tFlags, tEffLast, tokId, path } = map;
  const lim = map.ambAt;
  const ranges: Array<[number, number]> = [];
  const T = tStart.length;

  const parts: string[] = [];
  let at = 0;
  // Masked up to lim; nothing at or past lim is read as structure.
  for (let t = 0; t < T && tStart[t] < lim; t++) {
    parts.push(content.slice(at, tStart[t]));
    const n = tEnd[t] - tStart[t];
    if (tKind[t] === K_STYLE_OPEN) parts.push("<style>" + filler(n - 7));
    else if (tKind[t] === K_STYLE_CLOSE) parts.push("</style>" + filler(n - 8));
    else parts.push(filler(n));
    at = tEnd[t];
  }
  parts.push(content.slice(at));
  const copy = parts.join("");

  const firstTokAt = (a: number) => {
    let lo = 0;
    let hi = T;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tStart[mid] < a) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** Whether any token starting in [a, b) fails `bad`. */
  const anyTok = (a: number, b: number, bad: (t: number) => boolean) => {
    for (let t = firstTokAt(a); t < T && tStart[t] < b; t++) if (bad(t)) return true;
    return false;
  };
  const markup = (t: number) => (tFlags[t] & F_MARKUP) !== 0;
  const emitsWith = (t: number, f: number) => tKind[t] === K_EMIT && (tFlags[t] & f) !== 0;

  const nextBangEnd = finder(copy, /--!>/g);
  const nextCdataEnd = finder(copy, /\]\]>/g);
  const nextEscOpen = finder(copy, /<!--/g);
  const nextDashEnd = finder(copy, /-->/g);
  const nextScriptOpen = finder(copy, /<script(?=[\t\n\f\r />])/gi);
  const closers = new Map<string, (i: number) => number>();
  const closeFinder = (name: string) => {
    let f = closers.get(name);
    if (!f) {
      f = finder(copy, new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi"));
      closers.set(name, f);
    }
    return f;
  };

  let tagName = "";
  let selfClosing = false;
  /** Walk a start/end tag from `from` (after `<` or `</`). Its end, or -1 (ambiguous). */
  const walkTag = (lt: number, from: number): number => {
    let j = from;
    let masked = false;
    while (j < lim) {
      if (tokId[j] >= 0) {
        masked = true;
        j = tEnd[tokId[j]];
        continue;
      }
      if (charClass(copy.charCodeAt(j)) <= 2) break;
      j++;
    }
    // Only names up to 9 chars ("plaintext") can be special.
    tagName = masked || j - from > 9 ? "" : asciiLower(copy.slice(from, j));
    let set = 1 << S_TN;
    const frames: Array<{ saved: number; loop: boolean; checked: boolean }> = [];
    for (let i = from; i < lim; ) {
      const t = tokId[i];
      if (t >= 0) {
        const kind = tKind[t];
        const flags = tFlags[t];
        if (flags & F_MARKUP) return -1;
        if (kind === K_EMIT) {
          if (set & ~QUOTED && flags & (F_LIT_DQ | F_LIT_SQ | F_LIT_EQWS)) return -1;
          if (set & (1 << S_DQ) && flags & F_LIT_DQ) return -1;
          if (set & (1 << S_SQ) && flags & F_LIT_SQ) return -1;
          set |= FILL_NEXT[set];
        } else if (kind === K_OPEN) {
          frames.push({ saved: set, loop: (flags & F_LOOP) !== 0, checked: false });
        } else if (kind === K_BRANCH || kind === K_CLOSE) {
          const top = kind === K_BRANCH ? frames[frames.length - 1] : frames.pop();
          if (!top) return -1;
          // A loop body may repeat: it must not move the tag to new states.
          if (top.loop && !top.checked && set & ~top.saved) return -1;
          top.checked = true;
          set |= top.saved;
        }
        i = tEnd[t];
        continue;
      }
      const c = copy.charCodeAt(i);
      // Hard limit kept from audit r2: a '<' where an attribute name may start
      // or run (not inside a value) is ambiguous, not modeled. (Quotes there
      // are name chars; the state sets above model them exactly.)
      if (c === 60 && set & NAME_STATES) return -1;
      const idx = set * 7 + charClass(c);
      const ends = ENDS[idx];
      if (ends) {
        if (ends !== set || frames.length > 0 || path[i] !== path[lt]) return -1;
        selfClosing = ENDS_SC[idx] === set;
        return i + 1;
      }
      set = NEXT[idx];
      i++;
    }
    return -1;
  };

  /** Body end of a script (escape states), -1 unclosed, -2 ambiguous. */
  const scriptBody = (from: number, lt: number): number => {
    const close = closeFinder("script");
    let k = from;
    let st = 0; // 0 data, 1 escaped, 2 double escaped
    let escStart = -1;
    const valid = (x: number) => x !== -1 && x < lim;
    for (;;) {
      const c = close(k);
      const d = st === 0 ? -1 : nextDashEnd(k);
      const o = st === 0 ? nextEscOpen(k) : st === 1 ? nextScriptOpen(k) : -1;
      let best = -1;
      for (const x of [c, d, o]) if (valid(x) && (best === -1 || x < best)) best = x;
      if (best === -1) return -1;
      if (path[best] !== path[lt]) return -2;
      if (best === c && st !== 2) {
        if (escStart !== -1 && anyTok(escStart, c, () => true)) return -2;
        return c;
      }
      if (best === c) {
        st = 1;
        k = c + 8;
      } else if (best === d) {
        st = 0;
        k = d + 3;
      } else if (st === 0) {
        if (escStart === -1) escStart = o;
        st = 1;
        k = o + 2; // `<!-->` and `<!--->` end the escape at once
      } else {
        st = 2;
        k = o + 7;
      }
    }
  };

  let ambAt = len;
  const strict: Array<{ name: string; path: number }> = [];
  const tmpl: Array<{ path: number; start: number }> = [];
  let i = 0;
  main: for (;;) {
    const lt = copy.indexOf("<", i);
    if (lt === -1 || lt + 1 >= lim) break;
    i = lt + 1;
    if (tokId[lt + 1] >= 0) {
      ambAt = lt;
      break;
    }
    const c1 = copy.charCodeAt(lt + 1);
    let end: number;

    if (c1 === 33 && copy.startsWith("<!--", lt)) {
      const d = copy.indexOf("-->", lt + 2);
      const b = nextBangEnd(lt + 4);
      let term = d;
      let tlen = 3;
      if (b !== -1 && (d === -1 || b < d)) {
        term = b;
        tlen = 4;
      }
      if (term === -1 || term >= lim || path[term] !== path[lt]) {
        ambAt = lt;
        break;
      }
      end = term + tlen;
      if (
        anyTok(
          lt,
          end,
          (t) => markup(t) || emitsWith(t, F_LIT_DASH) || tEffLast[t] === 45 || tEffLast[t] === 33,
        )
      ) {
        ambAt = lt;
        break;
      }
      ranges.push([lt, end]);
      i = end;
      continue;
    }

    if (c1 === 33 && copy.startsWith("<![CDATA[", lt)) {
      // Foreign content: to `]]>`; HTML: a bogus comment to `>`. Both must agree.
      const g = copy.indexOf(">", lt + 9);
      const k = nextCdataEnd(lt + 9);
      if (g === -1 || k === -1 || k >= lim || g !== k + 2 || path[k] !== path[lt]) {
        ambAt = lt;
        break;
      }
      end = k + 3;
      if (anyTok(lt, end, (t) => markup(t) || emitsWith(t, F_LIT_BRACKET) || tEffLast[t] === 93)) {
        ambAt = lt;
        break;
      }
      ranges.push([lt, end]);
      i = end;
      continue;
    }

    const isEnd = c1 === 47;
    if (isEnd) {
      if (lt + 2 >= lim) break;
      if (tokId[lt + 2] >= 0) {
        ambAt = lt;
        break;
      }
      if (copy.charCodeAt(lt + 2) === 62) {
        i = lt + 3; // `</>` is dropped
        continue;
      }
    }
    const nameAt = isEnd ? lt + 2 : lt + 1;
    if (c1 === 33 || c1 === 63 || (isEnd && !isAsciiAlpha(copy.charCodeAt(lt + 2)))) {
      // Bogus comment (`<!x`, `<?x`, `</3`): to the next `>`.
      const g = copy.indexOf(">", lt + 2);
      if (g === -1 || g >= lim || path[g] !== path[lt] || anyTok(lt, g, markup)) {
        ambAt = lt;
        break;
      }
      end = g + 1;
      ranges.push([lt, end]);
      i = end;
      continue;
    }
    if (!isAsciiAlpha(copy.charCodeAt(nameAt))) continue; // text

    end = walkTag(lt, nameAt);
    if (end === -1) {
      ambAt = lt;
      break;
    }
    // The tag's interior is never a fix target: a span starts only at a real '<'.
    ranges.push([lt + 1, end]);
    i = end;
    const name = tagName;
    if (isEnd) {
      const top = name === "template" ? tmpl.pop() : undefined;
      if (top) {
        if (top.path !== path[lt]) {
          ambAt = lt;
          break;
        }
        if (tmpl.length === 0) ranges.push([top.start, lt]);
      } else if (STRICT_ELEMENTS.has(name)) {
        let j = strict.length - 1;
        while (j >= 0 && strict[j].name !== name) j--;
        if (j >= 0) {
          if (strict[j].path !== path[lt]) {
            ambAt = lt;
            break;
          }
          strict.length = j;
        }
      }
      continue;
    }
    if (name === "plaintext") {
      if (end < len) ranges.push([end, len]);
      i = len;
      break;
    }
    if (name === "template") {
      tmpl.push({ path: path[lt], start: end });
      continue;
    }
    if (STRICT_ELEMENTS.has(name)) {
      if (!selfClosing || name === "select") strict.push({ name, path: path[lt] });
      continue;
    }
    if (!BODY_ELEMENTS.has(name)) continue;

    const bodyStart = end;
    const bodyEnd = name === "script" ? scriptBody(bodyStart, lt) : closeFinder(name)(bodyStart);
    if (bodyEnd === -2) {
      ambAt = lt;
      break;
    }
    if (bodyEnd === -1 || bodyEnd >= lim) {
      // Unclosed: the body runs to the end of the file.
      if (bodyStart < len) ranges.push([bodyStart, len]);
      i = len;
      break main;
    }
    if (path[bodyEnd] !== path[lt] || anyTok(bodyStart, bodyEnd, markup)) {
      ambAt = lt;
      break;
    }
    if (strict.length > 0) {
      // Inside svg/math/select the body may be markup, not text: only a
      // body with no '<' reads the same both ways.
      const k = copy.indexOf("<", bodyStart);
      if (k !== -1 && k < bodyEnd) {
        ambAt = lt;
        break;
      }
    }
    if (bodyEnd > bodyStart) ranges.push([bodyStart, bodyEnd]);
    i = bodyEnd;
  }
  // Template content still open at the end (or at an ambiguity) runs to EOF.
  if (tmpl.length > 0) ranges.push([tmpl[0].start, len]);
  return { ranges, ambAt };
}

/** Per ranges array: the token map removalSpanFor needs (no signature change). */
type SpanGuard = {
  content: string;
  amb: number;
  tStart: number[];
  tEnd: number[];
  tFlags: number[];
};
const guards = new WeakMap<ReadonlyArray<[number, number]>, SpanGuard>();

/** `list` sorted by start (in place; most lists arrive sorted already). */
function sortedByStart(list: Array<[number, number]>): Array<[number, number]> {
  for (let k = 1; k < list.length; k++) {
    if (list[k - 1][0] > list[k][0]) return list.sort((x, y) => x[0] - y[0]);
  }
  return list;
}

function analyze(content: string): { ranges: Array<[number, number]>; guard: SpanGuard } {
  const len = content.length;
  const map = liquidMap(content);
  const html = htmlScan(content, map);
  const tail = Math.min(map.ambRangeAt, html.ambAt);
  const a = sortedByStart(map.ranges);
  const b = sortedByStart(html.ranges);
  if (tail < len) b.push([tail, len]);
  // Two-way merge by start, then union.
  const ranges: Array<[number, number]> = [];
  let last: [number, number] | null = null;
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    const r = j >= b.length || (i < a.length && a[i][0] <= b[j][0]) ? a[i++] : b[j++];
    const s = r[0];
    const e = r[1];
    if (s >= e || s >= tail + 1) continue;
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      last = [s, e];
      ranges.push(last);
    }
  }
  const guard: SpanGuard = {
    content,
    amb: Math.min(map.ambAt, html.ambAt),
    tStart: map.tStart,
    tEnd: map.tEnd,
    tFlags: map.tFlags,
  };
  return { ranges, guard };
}

/**
 * [start, end) ranges where markup is not live code, sorted and
 * non-overlapping (inRanges relies on it). Phase 1 (Liquid, raw text):
 * comment/doc blocks (nested), raw/schema/javascript/stylesheet and style
 * blocks, `{%# %}`, the interior of every other Liquid tag and output, and
 * string literals and comment lines in `{% liquid %}`. Phase 2 (HTML, on a
 * copy with Liquid masked): comments, bogus comments, CDATA, the interior of
 * every tag, text-only element bodies (script escapes modeled), template
 * content (nested), `<plaintext>` to EOF. AMBIGUOUS (the rest of the file is
 * non-code): Liquid that may complete a dangerous tag name or a comment/CDATA
 * opener or end, emitted literals holding `<` or `>`, tag/comment/body
 * boundaries on different control-flow branches, tag structure that depends
 * on whether a token renders, unclosed or mismatched anything.
 */
export function nonCodeRanges(content: string): Array<[number, number]> {
  const { ranges, guard } = analyze(content);
  guards.set(ranges, guard);
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
 * A span must not cut a Liquid token in two (a bare render line may sit inside
 * its own `{% liquid %}` tag), hold a control-flow tag, or reach into the
 * ambiguous tail of the file.
 */
function spanGuardRefusal(
  guard: SpanGuard,
  span: RemovalSpan,
  bareLine: boolean,
): SpanRefusal | null {
  const { start: s, end: e } = span;
  if (s < guard.amb && e > guard.amb) return "IN_NON_CODE_REGION";
  const { tStart, tEnd, tFlags } = guard;
  // Last token starting at or before s.
  let lo = 0;
  let hi = tStart.length - 1;
  let t = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tStart[mid] <= s) {
      t = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (t !== -1 && tStart[t] < s && s < tEnd[t]) {
    const inOwnLiquidTag = bareLine && tFlags[t] & F_LIQUID_TAG && e <= tEnd[t] - 2;
    if (!inOwnLiquidTag) return "IN_NON_CODE_REGION";
    return null;
  }
  for (let k = t + 1; k < tStart.length && tStart[k] < e; k++) {
    if (tFlags[k] & F_CONTROL) return "LIQUID_TAG_IN_ELEMENT";
    if (tEnd[k] > e) return "IN_NON_CODE_REGION";
  }
  if (t !== -1 && tStart[t] === s && tFlags[t] & F_CONTROL) return "LIQUID_TAG_IN_ELEMENT";
  return null;
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
  let bareLine = false;
  switch (findingType) {
    case "GHOST_SCRIPT":
      result = scriptElementSpan(content, matchStart);
      break;
    case "GHOST_STYLE":
    case "GHOST_PRECONNECT":
      result = linkElementSpan(content, matchStart);
      break;
    case "GHOST_SNIPPET":
      bareLine = content[matchStart] !== "{";
      result = bareLine
        ? bareLiquidStatementSpan(content, matchStart, blocks)
        : liquidRenderTagSpan(content, matchStart);
      break;
    default:
      // Runtime guard: callers pass stored enum strings, so an unknown type
      // must refuse, never fall through to undefined.
      return refuse("NOT_FIXABLE_TYPE");
  }
  if (!result.ok) return result;
  if (result.span.end - result.span.start > MAX_SPAN_CHARS) return refuse("SPAN_TOO_LONG");
  let guard = guards.get(ranges);
  if (!guard || guard.content !== content) guard = analyze(content).guard;
  const refusal = spanGuardRefusal(guard, result.span, bareLine);
  return refusal ? refuse(refusal) : result;
}
