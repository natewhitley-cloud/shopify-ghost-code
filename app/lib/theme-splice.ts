/**
 * Splice engine for the clean-copy fix (gc-tib slice 2).
 *
 * Pure: (file content, removal spans) -> new content. Spans come from
 * removal-span.ts. Each accepted span is cut out; a line left holding only
 * whitespace is then dropped with its line ending. Every byte outside the
 * removed spans and dropped lines is kept exactly.
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
  | "UNBALANCED_LIQUID";

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

  // Cut the spans, remembering where each cut lands in the output.
  let out = "";
  let cursor = 0;
  const cutPoints: number[] = [];
  for (const s of accepted) {
    out += content.slice(cursor, s.start);
    cutPoints.push(out.length);
    cursor = s.end;
  }
  out += content.slice(cursor);

  // Drop each line a cut left blank (only those lines; pre-existing blank
  // lines are untouched). Process from the end so earlier offsets stay valid.
  const dropped = new Set<number>();
  for (let k = cutPoints.length - 1; k >= 0; k--) {
    const at = cutPoints[k];
    const lineStart = out.lastIndexOf("\n", at - 1) + 1;
    if (dropped.has(lineStart)) continue;
    let lineEnd = out.indexOf("\n", at);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) lineEnd = out.length;
    const body = out.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (!isBlank(body)) continue;
    dropped.add(lineStart);
    if (hasNewline) {
      out = out.slice(0, lineStart) + out.slice(lineEnd + 1);
    } else if (lineStart > 0) {
      // Last line with no terminator: take the previous line ending instead.
      const prevEnd = out[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1;
      out = out.slice(0, prevEnd);
    } else {
      out = "";
    }
  }

  return { content: out, removed: accepted, refused };
}
