/**
 * Canvas hint (gc-tib.12, spike docs/spikes/2026-11-03-gc-dg5e-canvas-themes.md).
 * The Admin API has no Canvas marker, and Shopify staff said a Canvas-edited
 * live theme may not appear in the `themes` query. So when we can't find the
 * live theme, Canvas is a likely reason: say so next to "no live theme".
 */
export const CANVAS_THEME_HINT = "If you edit your theme with Canvas, GhostCode can't read it yet.";
