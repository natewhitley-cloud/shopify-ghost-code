/**
 * Live-app suppression shared by the scan engine (dropActiveAppOwnFileFindings)
 * and the scan differ (gc-2x0o). Kept out of scan-engine.server so the differ
 * does not depend on the engine.
 */
import { FindingType } from "@prisma/client";

import { identifyAppFromFilename } from "./app-lookup.server";

/**
 * "This code belongs to app X" finding types (gc-clt4, gc-ps3t): the types a
 * live app produces in the theme just by working. Only these may be
 * dropped by dropActiveAppOwnFileFindings. GHOST_OG is included (2026-10-05,
 * Nathan): a live app's og tags (real case: EComposer's helper snippet, which
 * only renders on its own pages) are the app working, not leftover code.
 * Never add MALICIOUS_SCRIPT, the app-embed types, GHOST_LAYOUT (layouts
 * already have a template-usage gate), DUPLICATE_*, OVERLAPPING_CHAT_WIDGET,
 * SETTINGS_DRIFT, JSON_LD_*, or the robots/canonical/title/meta types: those
 * are not "app X's code" claims.
 */
export const ACTIVE_APP_OWN_FILE_TYPES: ReadonlySet<FindingType> = new Set<FindingType>([
  FindingType.GHOST_SCRIPT,
  FindingType.GHOST_STYLE,
  FindingType.GHOST_SNIPPET,
  FindingType.GHOST_SECTION,
  FindingType.GHOST_TEXT,
  FindingType.GHOST_PIXEL,
  FindingType.GHOST_PRECONNECT,
  FindingType.GHOST_FONT,
  FindingType.GHOST_AJAX,
  FindingType.GHOST_JSON_LD,
  FindingType.GHOST_HREFLANG,
  FindingType.GHOST_OG,
  FindingType.ORPHAN_ASSET,
]);

/**
 * Whether dropActiveAppOwnFileFindings (scan-engine.server) drops `f` for
 * these live apps: (1A) its appName is live, or (2A) its file is owned by a
 * live app (signature `filePatterns`). Also used by the scan differ, so a
 * prior finding the engine now drops because its app went live is never
 * counted "Fixed" (gc-2x0o).
 */
export function isLiveAppOwnFinding(
  f: { findingType: string; appName?: string | null; filename: string },
  activeApps: ReadonlySet<string>,
): boolean {
  if (!(ACTIVE_APP_OWN_FILE_TYPES as ReadonlySet<string>).has(f.findingType)) return false;
  if (f.appName && activeApps.has(f.appName)) return true;
  const fileOwner = identifyAppFromFilename(f.filename)?.appName;
  return !!fileOwner && activeApps.has(fileOwner);
}
