/**
 * Splice engine for the clean-copy fix (gc-tib slice 2).
 *
 * Pure: (file content, removal spans) -> new content. Spans come from
 * removal-span.ts. Each accepted span is cut out; a line left holding only
 * whitespace is then dropped with its line ending. Every byte outside the
 * removed spans and dropped lines is kept exactly.
 *
 * Structure re-check (gc-t44r M4b): the output's non-code ranges must equal
 * the input's with the removed text dropped and the rest shifted. Otherwise
 * removing an element changed how the rest of the file parses (`<` + `!--`
 * meeting across a cut), and the whole file is refused.
 *
 * Whitespace-control note: removing `{%- render -%}` also removes its trim
 * effect, so whitespace that the tag used to strip around it is rendered again.
 * In HTML this is insignificant; it is documented here and pinned by a test.
 *
 * Pure, client-safe module (no .server suffix).
 */

import { inRanges, nonCodeRanges, type RemovalSpan } from "./removal-span";

export type SpliceRefusal =
  /** Span is empty, inverted or outside the content. */
  | "OUT_OF_BOUNDS"
  /** Span overlaps or duplicates another requested span (both refused). */
  | "OVERLAPPING_SPANS"
  /** Span starts inside a comment / raw / script-body region. */
  | "IN_NON_CODE_REGION"
  /** Span text has unbalanced Liquid delimiters; removing it would break the template. */
  | "UNBALANCED_LIQUID"
  /** The spliced file would parse differently around the cuts: every span in the file is refused. */
  | "STRUCTURE_CHANGED";

export type SpliceResult = {
  content: string;
  /** Accepted spans (input coordinates), ascending. */
  removed: RemovalSpan[];
  refused: Array<{ span: RemovalSpan; reason: SpliceRefusal }>;
};

function count(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

function liquidBalanced(text: string): boolean {
  return count(text, "{%") === count(text, "%}") && count(text, "{{") === count(text, "}}");
}

function isBlank(text: string): boolean {
  return /^[ \t\f\v]*$/.test(text);
}

export function spliceSpans(content: string, spans: readonly RemovalSpan[]): SpliceResult {
  const refused: SpliceResult["refused"] = [];
  const inBounds: RemovalSpan[] = [];
  for (const s of spans) {
    if (
      !Number.isInteger(s.start) ||
      !Number.isInteger(s.end) ||
      s.start < 0 ||
      s.end > content.length ||
      s.end <= s.start
    ) {
      refused.push({ span: s, reason: "OUT_OF_BOUNDS" });
    } else {
      inBounds.push({ start: s.start, end: s.end });
    }
  }

  // Overlap (or duplicate): refuse every span in an overlapping cluster.
  inBounds.sort((a, b) => a.start - b.start || a.end - b.end);
  const overlapping = new Set<number>();
  let maxEnd = -1;
  let maxEndIdx = -1;
  for (let i = 0; i < inBounds.length; i++) {
    if (inBounds[i].start < maxEnd) {
      overlapping.add(i);
      overlapping.add(maxEndIdx);
    }
    if (inBounds[i].end > maxEnd) {
      maxEnd = inBounds[i].end;
      maxEndIdx = i;
    }
  }

  const ranges = nonCodeRanges(content);
  const accepted: RemovalSpan[] = [];
  inBounds.forEach((s, i) => {
    if (overlapping.has(i)) refused.push({ span: s, reason: "OVERLAPPING_SPANS" });
    else if (inRanges(ranges, s.start)) refused.push({ span: s, reason: "IN_NON_CODE_REGION" });
    else if (!liquidBalanced(content.slice(s.start, s.end)))
      refused.push({ span: s, reason: "UNBALANCED_LIQUID" });
    else accepted.push(s);
  });

  // Cut the spans, remembering where each cut lands in the output and which
  // input offset each kept piece starts at.
  let out = "";
  let cursor = 0;
  const cutPoints: number[] = [];
  const pieceOut: number[] = [];
  const pieceIn: number[] = [];
  for (const s of accepted) {
    pieceOut.push(out.length);
    pieceIn.push(cursor);
    out += content.slice(cursor, s.start);
    cutPoints.push(out.length);
    cursor = s.end;
  }
  pieceOut.push(out.length);
  pieceIn.push(cursor);
  out += content.slice(cursor);
  /** Dropped line text, in cut-output offsets (before any drop). */
  const droppedOut: Array<[number, number]> = [];

  // Drop each line a cut left blank (only those lines; pre-existing blank
  // lines are untouched). Process from the end so earlier offsets stay valid.
  const dropped = new Set<number>();
  for (let k = cutPoints.length - 1; k >= 0; k--) {
    const at = cutPoints[k];
    // at = 0: lastIndexOf("\n", -1) would still match a "\n" at index 0.
    const lineStart = at === 0 ? 0 : out.lastIndexOf("\n", at - 1) + 1;
    if (dropped.has(lineStart)) continue;
    let lineEnd = out.indexOf("\n", at);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) lineEnd = out.length;
    const body = out.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (!isBlank(body)) continue;
    dropped.add(lineStart);
    if (hasNewline) {
      droppedOut.push([lineStart, lineEnd + 1]);
      out = out.slice(0, lineStart) + out.slice(lineEnd + 1);
    } else if (lineStart > 0) {
      // Last line with no terminator: take the previous line ending instead.
      const prevEnd = out[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1;
      droppedOut.push([prevEnd, out.length]);
      out = out.slice(0, prevEnd);
    } else {
      droppedOut.push([0, out.length]);
      out = "";
    }
  }

  if (
    accepted.length > 0 &&
    !sameStructure(content, ranges, out, accepted, droppedOut, pieceOut, pieceIn)
  ) {
    for (const s of accepted) refused.push({ span: s, reason: "STRUCTURE_CHANGED" });
    return { content, removed: [], refused };
  }
  return { content: out, removed: accepted, refused };
}

/**
 * Whether nonCodeRanges(out) equals the input's ranges with every removed
 * char (spans and dropped line text) taken out and the rest shifted.
 * `pieceOut`/`pieceIn` map the cut output (before line drops) back to input.
 */
function sameStructure(
  content: string,
  ranges: ReadonlyArray<[number, number]>,
  out: string,
  spans: readonly RemovalSpan[],
  droppedOut: ReadonlyArray<[number, number]>,
  pieceOut: readonly number[],
  pieceIn: readonly number[],
): boolean {
  const removed = new Uint8Array(content.length);
  for (const s of spans) removed.fill(1, s.start, s.end);
  // droppedOut is in descending order (lines are dropped from the end), so
  // one piece pointer walks down once over all of them: linear (X8).
  let p = pieceOut.length - 1;
  for (const [a, b] of droppedOut) {
    for (let x = b - 1; x >= a; x--) {
      while (pieceOut[p] > x) p--;
      removed[pieceIn[p] + (x - pieceOut[p])] = 1;
    }
  }
  // removedBefore[x] = removed input chars before offset x.
  const removedBefore = new Int32Array(content.length + 1);
  for (let x = 0; x < content.length; x++) removedBefore[x + 1] = removedBefore[x] + removed[x];
  const expected: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    const s = a - removedBefore[a];
    const e = b - removedBefore[b];
    if (s >= e) continue;
    const last = expected[expected.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else expected.push([s, e]);
  }
  const actual = nonCodeRanges(out);
  if (actual.length !== expected.length) return false;
  for (let k = 0; k < actual.length; k++) {
    if (actual[k][0] !== expected[k][0] || actual[k][1] !== expected[k][1]) return false;
  }
  return true;
}
