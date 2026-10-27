/**
 * Unescaped menu-label detector (gc-7gjj.2, spike gc-7gjj §1.5 Phase 0): a
 * DARK signal, ops telemetry only. Finds Liquid that prints a navigation menu
 * label (`link.title`, a menu's `title`) as raw HTML. Liquid never
 * auto-escapes: `{{ link.title }}` and `{% echo link.title %}` print the
 * string as written, so a label holding `<img src=x onerror=...>` runs (the
 * October 2026 17TRACK campaign). Dawn escapes every menu title; Horizon
 * prints them raw in its desktop header, mega menu and menu block.
 *
 * Phase 0 only counts hits into the per-scan `scan_signal` OpsEvent behind
 * MENU_LABEL_SIGNAL_ENABLED, to measure how common this is per theme before
 * any merchant-facing finding (gc-7gjj.3). It creates no Finding rows.
 *
 * What counts, per file (two passes over its Liquid tokens):
 *   1. Menu loops: `{% for <var> in <expr>.links %}` (also in `{% liquid %}`
 *      blocks). `<var>` is a menu link; `<expr>` is a menu (or a parent link)
 *      when it is a plain variable path (`menu`, `block.settings.menu`,
 *      `linklists['main-menu']`). Collected over the whole file first, because
 *      a theme can print `menu.title` above the loop (Horizon blocks/menu).
 *   2. In file order: `{% assign x = <label> %}` makes `x` an alias of a label
 *      (one level), and every output, `{{ ... }}` or `echo ...`, that names a
 *      label (`<var>.title`, `<expr>.title`, or an alias) with no neutralising
 *      filter anywhere in its chain is an unescaped print.
 * Neutralising filters: escape, escape_once, strip_html, url_encode,
 * url_escape, handleize/handle, size, and t (translations are escaped by
 * default; `'key' | t: title: link.title` is not counted).
 *
 * Known limits (a Phase 0 signal tolerates them): a label passed to another
 * file (`{% render 'x', link: link %}`) is not followed; a loop over
 * `linklists[...].links[i]` by index is not seen; a loop variable stays
 * tracked to the end of the file.
 *
 * Pure and linear: one forward walk over the tokens (each `{{`/`{%` finds its
 * close once; an unclosed one ends the walk), and per-token regexes with
 * bounded or disjoint quantifiers. The caller passes content with Liquid
 * that never executes already blanked, line breaks kept
 * (blankNonExecutingLiquid with keepLength), so a print inside a comment or a
 * `{% raw %}` block (printed as text) does not count (audit fix).
 */

/**
 * Per-file result: the distinct 1-based lines holding an unescaped print, and
 * how many prints there are (two on one line count twice; audit fix).
 */
export type UnescapedMenuLabelResult = { lines: number[]; outputCount: number };

/** Per-scan aggregate written to scan_signal metadata (`menuLabels`). */
export type UnescapedMenuLabelSummary = {
  /** Every file with at least one unescaped print this scan (not capped). */
  fileCount: number;
  /** Every unescaped print this scan, across files. */
  outputCount: number;
  /** The first MENU_LABEL_FILES_CAP files, sorted by path, with their lines (each capped). */
  files: Array<{ path: string; lines: number[] }>;
};

export const MENU_LABEL_FILES_CAP = 20;
export const MENU_LABEL_LINES_CAP = 20;

/** Filters after which a printed label can no longer be markup. */
const NEUTRALISING_FILTERS: ReadonlySet<string> = new Set([
  "escape",
  "escape_once",
  "strip_html",
  "url_encode",
  "url_escape",
  "handleize",
  "handle",
  "size",
  "t",
]);

const TOKEN_START_RE = /\{[{%]/g;
// A Liquid variable path: name, then `.name` or `[...]` parts (bounded index).
const VAR_PATH_RE = /[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[[^\]\n]{0,200}\])*/g;
// `for <var> in <expr>.links`, `<expr>` a variable path (filters/params after).
const FOR_LINKS_RE =
  /^for[ \t\r\n]+([A-Za-z_][\w-]*)[ \t\r\n]+in[ \t\r\n]+([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[[^\]\n]{0,200}\])*)\.links(?![\w-])/;
const ASSIGN_RE = /^assign[ \t\r\n]+([A-Za-z_][\w-]*)[ \t\r\n]*=([^]*)$/;
const ECHO_RE = /^echo(?:[ \t\r\n]+([^]*))?$/;
const QUOTED_RE = /'[^']*'|"[^"]*"/g;

/** One Liquid statement: an output expression, or a tag's name + markup. */
type Statement =
  | { kind: "output"; expr: string; at: number }
  | { kind: "tag"; text: string; at: number };

/** Every statement of a file, in order, with its offset (linear). */
function statements(content: string): Statement[] {
  const out: Statement[] = [];
  TOKEN_START_RE.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = TOKEN_START_RE.exec(content)) !== null) {
    const at = found.index;
    const isOutput = content[at + 1] === "{";
    const close = content.indexOf(isOutput ? "}}" : "%}", at + 2);
    if (close === -1) break;
    TOKEN_START_RE.lastIndex = close + 2;
    const inner = content
      .slice(at + 2, close)
      .replace(/^-/, "")
      .replace(/-$/, "")
      .trim();
    if (isOutput) {
      out.push({ kind: "output", expr: inner, at });
      continue;
    }
    if (/^liquid(?![\w-])/.test(inner)) {
      // `{% liquid %}`: one tag per line, no delimiters. Each line's own
      // offset, so its print is reported on its own line.
      const bodyStart = content.indexOf("liquid", at) + "liquid".length;
      let offset = bodyStart;
      for (const line of content.slice(bodyStart, close).split("\n")) {
        const text = line.trim().replace(/-$/, "").trim();
        if (text) out.push({ kind: "tag", text, at: offset });
        offset += line.length + 1;
      }
      continue;
    }
    out.push({ kind: "tag", text: inner, at });
  }
  return out;
}

/** An expression's base and filter names (quoted strings removed first). */
function parseExpression(expr: string): { paths: string[]; filters: string[] } {
  const unquoted = expr.replace(QUOTED_RE, "''");
  const [, ...filterParts] = unquoted.split("|");
  const filters = filterParts.map((part) => part.trim().split(/[\s:]/, 1)[0]);
  return { paths: unquoted.match(VAR_PATH_RE) ?? [], filters };
}

/** Whether an expression names a label with no neutralising filter in its chain. */
function printsLabelRaw(expr: string, isLabel: (path: string) => boolean): boolean {
  const { paths, filters } = parseExpression(expr);
  if (!paths.some(isLabel)) return false;
  return !filters.some((f) => NEUTRALISING_FILTERS.has(f));
}

/** 1-based line of each offset, offsets ascending (linear). */
function linesOf(content: string, offsets: number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let pos = 0;
  for (const at of offsets) {
    for (; pos < at; pos++) if (content.charCodeAt(pos) === 10) line++;
    lines.push(line);
  }
  return lines;
}

/**
 * The unescaped menu-label prints in one Liquid file's comment-blanked
 * content. See the module doc for what counts.
 */
export function detectUnescapedMenuLabels(content: string): UnescapedMenuLabelResult {
  if (!content.includes(".links")) return { lines: [], outputCount: 0 };
  const all = statements(content);

  // Pass 1: menu loops anywhere in the file.
  const linkVars = new Set<string>();
  const menuPaths = new Set<string>();
  for (const s of all) {
    if (s.kind !== "tag") continue;
    // Quotes normalised the same way as in parseExpression, so a menu path
    // with an index (`linklists['main-menu']`) matches its `.title` print.
    const loop = FOR_LINKS_RE.exec(s.text.replace(QUOTED_RE, "''"));
    if (!loop) continue;
    linkVars.add(loop[1]);
    menuPaths.add(loop[2]);
  }
  if (linkVars.size === 0) return { lines: [], outputCount: 0 };

  // Pass 2: aliases and prints, in order.
  const aliases = new Set<string>();
  const isLabel = (path: string): boolean => {
    if (aliases.has(path)) return true;
    if (!path.endsWith(".title")) return false;
    const owner = path.slice(0, -".title".length);
    return linkVars.has(owner) || menuPaths.has(owner);
  };
  const offsets: number[] = [];
  for (const s of all) {
    if (s.kind === "output") {
      if (printsLabelRaw(s.expr, isLabel)) offsets.push(s.at);
      continue;
    }
    const assign = ASSIGN_RE.exec(s.text);
    if (assign) {
      if (printsLabelRaw(assign[2], isLabel)) aliases.add(assign[1]);
      else aliases.delete(assign[1]);
      continue;
    }
    const echo = ECHO_RE.exec(s.text);
    if (echo && printsLabelRaw(echo[1] ?? "", isLabel)) offsets.push(s.at);
  }
  return { lines: [...new Set(linesOf(content, offsets))], outputCount: offsets.length };
}

/** Roll per-file hits up into the scan_signal shape (files sorted by path, capped). */
export function summarizeUnescapedMenuLabels(
  hits: Array<{ path: string; lines: number[]; outputCount: number }>,
): UnescapedMenuLabelSummary {
  const files = [...hits]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MENU_LABEL_FILES_CAP)
    .map((h) => ({ path: h.path, lines: h.lines.slice(0, MENU_LABEL_LINES_CAP) }));
  return {
    fileCount: hits.length,
    outputCount: hits.reduce((n, h) => n + h.outputCount, 0),
    files,
  };
}
