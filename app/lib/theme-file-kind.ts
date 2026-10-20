/**
 * Theme file classification for the "What changed" log (gc-rrh.4, spec 2.4).
 *
 * Pure and client-safe. The kind decides how a changed file is counted:
 *   - code:        counted as a change (layout, snippets, Liquid sections /
 *                  blocks / templates, script and style assets, the theme's
 *                  settings schema).
 *   - editor_data: never counted; a footnote. The theme editor rewrites these
 *                  on every save (settings_data, JSON templates, section groups).
 *   - locale:      never counted; a footnote (editor and Translate & Adapt saves).
 *   - static:      other assets (images, fonts).
 *   - other:       anything outside the folders above (e.g. a future theme
 *                  folder). Kept apart rather than guessed into a counted kind.
 */

export type ThemeFileKind = "code" | "editor_data" | "locale" | "static" | "other";

/** Asset extensions that are code (`.js.liquid` etc. end in `.liquid`). */
const CODE_ASSET = /\.(js|css|liquid)$/i;

export function classifyThemeFile(path: string): ThemeFileKind {
  const slash = path.indexOf("/");
  if (slash <= 0) return "other";
  const folder = path.slice(0, slash);
  const rest = path.slice(slash + 1);
  if (rest === "") return "other";
  const isLiquid = /\.liquid$/i.test(rest);
  const isJson = /\.json$/i.test(rest);

  switch (folder) {
    case "layout":
    case "snippets":
      return "code";
    case "sections":
      if (isLiquid) return "code";
      // Section groups (header-group.json etc.): editor-written.
      return isJson ? "editor_data" : "other";
    case "blocks":
      return isLiquid ? "code" : "other";
    case "templates":
      // Includes templates/customers/*.liquid and templates/customers/*.json.
      if (isLiquid) return "code";
      return isJson ? "editor_data" : "other";
    case "assets":
      return CODE_ASSET.test(rest) ? "code" : "static";
    case "config":
      if (rest === "settings_schema.json") return "code";
      if (rest === "settings_data.json") return "editor_data";
      return "other";
    case "locales":
      return isJson ? "locale" : "other";
    default:
      return "other";
  }
}
