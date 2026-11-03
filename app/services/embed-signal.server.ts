/**
 * Live-embed verification signal (gc-uczg). LOG ONLY: the result goes into the
 * scan_signal OpsEvent and the operator digest, never into a finding, the UI,
 * suppression, or anything a merchant sees.
 *
 * Compares what the storefront homepage renders (Shopify's `BEGIN app block`
 * comments) with the enabled theme app embeds in settings_data.json, plus the
 * extension scripts the page loads (gc-3ate), so mismatches can be studied
 * before detection or suppression changes. Homepage app blocks include
 * section app blocks, not only embeds, so onlyOnStorefront is not by itself
 * a detection miss.
 */

/** At most this many handles per list. */
export const MAX_EMBED_CHECK_HANDLES = 50;

/**
 * An extension handle as Shopify forms it. settings_data.json is theme-authored
 * (untrusted), so anything else is dropped rather than written to the log.
 */
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export type EmbedCheck = {
  storefrontBlocks: string[];
  settingsEmbeds: string[];
  extensions: string[];
  /** Rendered on the homepage, not an enabled embed in settings_data. */
  onlyOnStorefront: string[];
  /** Enabled in settings_data, not rendered on the homepage. */
  onlyInSettings: string[];
};

/**
 * Lower-cased, valid (HANDLE_RE), unique, sorted, at most
 * MAX_EMBED_CHECK_HANDLES. Also applied where theme-authored handles leave
 * the scan step (enabledAppEmbedHandles), so the step output stays bounded.
 */
export function cleanEmbedHandles(handles: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const h of handles) {
    const lower = h.toLowerCase();
    if (HANDLE_RE.test(lower)) out.add(lower);
  }
  return [...out].sort().slice(0, MAX_EMBED_CHECK_HANDLES);
}

export function compareEmbedSignals(input: {
  storefrontBlockHandles: readonly string[];
  settingsEmbedHandles: readonly string[];
  extensionHandles: readonly string[];
}): EmbedCheck {
  const storefrontBlocks = cleanEmbedHandles(input.storefrontBlockHandles);
  const settingsEmbeds = cleanEmbedHandles(input.settingsEmbedHandles);
  const onStorefront = new Set(storefrontBlocks);
  const inSettings = new Set(settingsEmbeds);
  return {
    storefrontBlocks,
    settingsEmbeds,
    extensions: cleanEmbedHandles(input.extensionHandles),
    onlyOnStorefront: storefrontBlocks.filter((h) => !inSettings.has(h)),
    onlyInSettings: settingsEmbeds.filter((h) => !onStorefront.has(h)),
  };
}
