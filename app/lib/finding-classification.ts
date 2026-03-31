/**
 * Finding classification utilities.
 *
 * Pure functions that classify findings based on their type. These are
 * client-safe (no .server.ts suffix) and have no external dependencies.
 */

/**
 * Finding types that always produce visible elements in the storefront —
 * things shoppers can see and interact with.
 */
const VISUAL_FINDING_TYPES = new Set([
  "GHOST_SECTION",
  "GHOST_SNIPPET",
  "GHOST_TEXT",
  "GHOST_PRICE",
  "GHOST_PAGE",
  "GHOST_LAYOUT",
  "GHOST_FONT",
]);

/**
 * Returns true if the given finding type produces visible elements in the
 * storefront (content shoppers can see), false for invisible code such as
 * head scripts, tracking pixels, metafields, SEO tags, and structured data.
 *
 * This is a pure function of findingType — no database lookup required.
 */
export function hasVisualImpact(findingType: string): boolean {
  return VISUAL_FINDING_TYPES.has(findingType);
}
