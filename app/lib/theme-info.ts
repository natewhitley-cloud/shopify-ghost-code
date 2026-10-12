/**
 * What a scanned theme says about itself (theme health, gc-i6du).
 *
 * Read from files the scan already fetched (no extra API call):
 *   - `config/settings_schema.json`: its `theme_info` entry carries the theme's
 *     name, version and author, e.g.
 *       { "name": "theme_info", "theme_name": "Dawn", "theme_version": "15.2.0",
 *         "theme_author": "Shopify", ... }
 *   - the template file names: an Online Store 2.0 theme has JSON templates
 *     (`templates/*.json`); a VINTAGE theme has only Liquid templates.
 *
 * Deliberately NOT here: "is this version behind the latest". Shopify has no
 * public API for a theme's latest version, and scraping the theme store is not
 * something this app does.
 *
 * Pure and client-safe (no .server suffix, no server imports): the scan worker
 * builds it, the Home loader parses the stored value, the checklist renders it.
 */

/** Stored strings are cut to this many characters (code points). */
export const MAX_THEME_INFO_CHARS = 80;

export const SETTINGS_SCHEMA_PATH = "config/settings_schema.json";

/**
 * - "os2": at least one JSON template (sections on every page, app blocks).
 * - "vintage": Liquid templates only.
 * - "unknown": no template files were seen at all, so nothing is claimed.
 */
export type ThemeArchitecture = "os2" | "vintage" | "unknown";

export interface ThemeInfo {
  name: string | null;
  version: string | null;
  author: string | null;
  architecture: ThemeArchitecture;
}

const ARCHITECTURES: ReadonlySet<unknown> = new Set(["os2", "vintage", "unknown"]);

/** A theme file as the scan holds it. */
type ThemeFileLike = { filename: string; content: string };

/** One leading block comment (Shopify's auto-generated header), nothing else. */
const LEADING_BLOCK_COMMENT_RE = /^\s*\/\*[\s\S]*?\*\//;

const JSON_TEMPLATE_RE = /^templates\/.+\.json$/;
const LIQUID_TEMPLATE_RE = /^templates\/.+\.liquid$/;

/** Half of a surrogate pair on its own (not valid text; JSONB rejects it). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A bounded, printable string, or null for anything else (or empty). */
function cleanField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters out, whitespace collapsed, lone surrogates dropped,
  // then the cap, counted in CODE POINTS so an emoji or other astral
  // character at the boundary is kept whole or dropped, never cut in half.
  // (The first slice only bounds the work on an absurdly long value: 4 code
  // units per kept character is more than any character needs.)
  const cleaned = value
    .slice(0, MAX_THEME_INFO_CHARS * 4)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(LONE_SURROGATE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Array.from(cleaned).slice(0, MAX_THEME_INFO_CHARS).join("").trim();
  return bounded.length > 0 ? bounded : null;
}

/** The `theme_info` entry of settings_schema.json, or null when unreadable. */
function readThemeInfoEntry(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(LEADING_BLOCK_COMMENT_RE, ""));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entry = parsed.find(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      (item as { name?: unknown }).name === "theme_info",
  );
  return (entry as Record<string, unknown> | undefined) ?? null;
}

/**
 * The theme's own description, from the scan's file set. Never throws: a
 * missing or malformed settings_schema.json leaves the three strings null,
 * and the architecture is still read from the template file names.
 */
export function readThemeInfo(files: readonly ThemeFileLike[]): ThemeInfo {
  let hasJsonTemplate = false;
  let hasLiquidTemplate = false;
  let schema: string | null = null;
  for (const file of files) {
    if (file.filename === SETTINGS_SCHEMA_PATH) schema = file.content;
    else if (JSON_TEMPLATE_RE.test(file.filename)) hasJsonTemplate = true;
    else if (LIQUID_TEMPLATE_RE.test(file.filename)) hasLiquidTemplate = true;
  }
  const entry = schema === null ? null : readThemeInfoEntry(schema);
  return {
    name: cleanField(entry?.theme_name),
    version: cleanField(entry?.theme_version),
    author: cleanField(entry?.theme_author),
    architecture: hasJsonTemplate ? "os2" : hasLiquidTemplate ? "vintage" : "unknown",
  };
}

/**
 * Parse `Scan.themeInfo` (Json?) back into a ThemeInfo, or null for a legacy
 * scan (NULL) or any value of another shape. Strings are re-bounded, so a
 * hand-edited row can never push long or control text into the page.
 */
export function parseThemeInfo(raw: unknown): ThemeInfo | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!ARCHITECTURES.has(value.architecture)) return null;
  return {
    name: cleanField(value.name),
    version: cleanField(value.version),
    author: cleanField(value.author),
    architecture: value.architecture as ThemeArchitecture,
  };
}
