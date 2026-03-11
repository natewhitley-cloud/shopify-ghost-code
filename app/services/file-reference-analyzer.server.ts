/**
 * File reference analyzer.
 *
 * Parses Liquid files for `render`, `include`, and `stylesheet_tag` references
 * and cross-references them against the full file inventory to identify snippet
 * files that are never referenced (orphan files).
 *
 * Scope:
 *   - Only snippet files (keys starting with `snippets/`) are candidates for
 *     orphan status.
 *   - References are extracted from ALL other Liquid files (sections/, layout/,
 *     templates/).
 *   - Variable-based render/include calls (e.g. `{% render variable %}`) cannot
 *     be resolved statically and are skipped.
 *
 * Note: Integration with scan-engine.server.ts is deferred to a later task.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanFile {
  filename: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNIPPETS_PREFIX = "snippets/";
const LIQUID_EXTENSION = ".liquid";

// Matches static render/include calls with either single or double quotes.
// Skips variable-based calls — those use an unquoted identifier after the tag.
//
// Breakdown:
//   \{%-?\s*          — opening tag, optional whitespace-stripping dash
//   (?:render|include) — the tag name
//   \s+               — required whitespace
//   ["']              — opening quote (captured to enforce matching close)
//   ([^"']+)          — the snippet name (no quotes inside)
//   ["']              — closing quote
//
// Using two separate patterns (one per quote style) is simpler and avoids
// back-reference complexity with the global flag.
const RENDER_SINGLE_RE = /\{%-?\s*(?:render|include)\s+'([^']+)'/g;
const RENDER_DOUBLE_RE = /\{%-?\s*(?:render|include)\s+"([^"]+)"/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the `snippets/` prefix and `.liquid` extension from a file key to
 * produce the bare snippet name used in render/include tags.
 *
 * Examples:
 *   "snippets/product-form.liquid" → "product-form"
 *   "snippets/app-widget"          → "app-widget"  (extension already absent)
 */
function snippetBaseName(key: string): string {
  let name = key;
  if (name.startsWith(SNIPPETS_PREFIX)) {
    name = name.slice(SNIPPETS_PREFIX.length);
  }
  if (name.endsWith(LIQUID_EXTENSION)) {
    name = name.slice(0, -LIQUID_EXTENSION.length);
  }
  return name;
}

/**
 * Extract all statically-resolvable snippet names referenced in a Liquid file.
 * Returns bare names (without path prefix or extension).
 */
function extractReferencedSnippetNames(content: string): Set<string> {
  const referenced = new Set<string>();

  let match: RegExpExecArray | null;

  RENDER_SINGLE_RE.lastIndex = 0;
  while ((match = RENDER_SINGLE_RE.exec(content)) !== null) {
    referenced.add(match[1]);
  }

  RENDER_DOUBLE_RE.lastIndex = 0;
  while ((match = RENDER_DOUBLE_RE.exec(content)) !== null) {
    referenced.add(match[1]);
  }

  return referenced;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a set of theme files and return snippet files that are never
 * referenced by any other Liquid file.
 *
 * @param files - Array of `{ key, value }` where `key` is the file path
 *   (e.g. `"snippets/my-widget.liquid"`) and `value` is the file content.
 *
 * @returns Orphan files sorted alphabetically by filename.
 */
export function analyzeFileReferences(
  files: Array<{ key: string; value: string }>,
): OrphanFile[] {
  // Step 1: Partition into snippet files and all-other Liquid files.
  const snippetFiles: Array<{ key: string; value: string }> = [];
  const nonSnippetLiquidFiles: Array<{ key: string; value: string }> = [];

  for (const file of files) {
    if (file.key.startsWith(SNIPPETS_PREFIX) && file.key.endsWith(LIQUID_EXTENSION)) {
      snippetFiles.push(file);
    } else if (file.key.endsWith(LIQUID_EXTENSION)) {
      nonSnippetLiquidFiles.push(file);
    }
  }

  // Step 2: Build the complete set of referenced snippet base names from
  // all non-snippet Liquid files.  We also scan snippet files themselves
  // because snippets can render other snippets.
  const allLiquidFiles = [...nonSnippetLiquidFiles, ...snippetFiles];
  const referencedNames = new Set<string>();

  for (const file of allLiquidFiles) {
    for (const name of extractReferencedSnippetNames(file.value)) {
      referencedNames.add(name);
    }
  }

  // Step 3: Any snippet whose base name is not in the referenced set is an orphan.
  const orphans: OrphanFile[] = [];

  for (const snippet of snippetFiles) {
    const baseName = snippetBaseName(snippet.key);
    if (!referencedNames.has(baseName)) {
      orphans.push({
        filename: snippet.key,
        reason: `Snippet '${baseName}' is never referenced by any render or include tag`,
      });
    }
  }

  // Step 4: Sort alphabetically by filename for stable, predictable output.
  orphans.sort((a, b) => a.filename.localeCompare(b.filename));

  return orphans;
}
