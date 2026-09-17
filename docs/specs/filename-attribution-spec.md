# Spec: Filename-based app attribution (gc-1ql)

Status: APPROVED (decisions locked 2026-09-17; ready to implement)
Bead: gc-1ql (P2, bug). Related: gc-rmb (Spreadr signature, P2), gc-ohn (EComposer cdnDomains, P3).
Author: session 2026-09-17
Evidence: real-merchant scan `cmu48sn2600s4qg01fyhx3i87` (d4c4c4.myshopify.com, 26 findings).

## 1. Problem

Ghost Code attributes each finding to the app that left the orphaned code. Today
that attribution is driven entirely by the _content_ of the code (inline tracker
call, script URL, snippet name), never by the _file the code lives in_. For a
large class of real-world leftovers the filename is the strongest and sometimes
the only correct signal, and the content signal actively points at the wrong app.

Observed on the first real merchant scan:

| Real orphaning app        | File                                                        | Attributed as (today)                                  | Why it went wrong                                                                           |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Spreadr (Amazon importer) | `snippets/spreadr.liquid`, `snippets/spreadr-custom.liquid` | "Facebook Pixel" x2, "Google Analytics (Universal)" x2 | Spreadr's code calls `fbq()` / `ga()`; the pixel detector matched the generic tracker call. |
| PageFly (page builder)    | `snippets/pagefly-main-js.liquid`                           | "Google Tag Manager", "Google Analytics"               | PageFly injected a gtag loader; URL/inline attribution matched the tracker, not PageFly.    |

Net: ~4 of 26 findings misattributed, and a merchant is told they have "Facebook
Pixel / Google Analytics ghost code" when they actually uninstalled Spreadr and
PageFly. This is both an accuracy defect and a positioning loss ("leftover code
from an app you removed" is the product's core story).

## 2. Root cause

- `AppSignature` (`app/data/app-signatures.server.ts`) has no filename field.
- `app/services/app-lookup.server.ts` has `identifyAppFromUrl / Code / SnippetName
/ HrefLang / JsonLd / TextFragment` but nothing keyed on the file path.
- `detectGhostPixels` (`app/services/scan-engine.server.ts:1388`) uses its OWN
  hardcoded `TRACKING_PATTERNS` table (fbq -> Facebook Pixel, gtag -> Google
  Analytics, ...) and never consults the filename.
- Script/stylesheet detectors (`~:412`, `~:460`) call
  `identifyAppFromUrl(url) ?? identifyAppFromCode(url)`; when a known app injects a
  generic tracker URL (e.g. `googletagmanager.com`), the tracker wins.

## 3. Goals / non-goals

Goals:

- Add source-filename as an attribution signal.
- Correctly attribute Spreadr and PageFly leftovers in the d4c4c4 fixture.
- Do not regress existing correct attributions (snippet-name, specific-app URL).
- Zero churn to the scan-differ resolved/new/persisted counts on the first
  post-deploy scan.

Non-goals:

- The domain graph (`collectThirdPartyDomains` / `ScanDomain`). It is NOT the lever
  here: Spreadr's leftovers are inline pixels with no external domain, so the
  domain graph would never surface Spreadr. Out of scope.
- Re-writing historical `Finding.appName` rows. Attribution is recomputed on the
  next scan; no backfill.

## 4. Design

### 4.1 Data model

Add one optional field to `AppSignature`:

```ts
export type AppSignature = {
  appName: string;
  cdnDomains: string[];
  scriptPatterns: RegExp[];
  snippetNames: string[];
  cssPatterns: RegExp[];
  hrefLangPatterns?: RegExp[];
  jsonLdPatterns?: RegExp[];
  textPatterns?: RegExp[];
  filePatterns?: RegExp[]; // NEW: match against the finding's file PATH (e.g. /(^|\/)spreadr[-.]/i)
  isTracker?: boolean;
};
```

`filePatterns` match the theme file path (`file.filename`, e.g.
`snippets/spreadr-custom.liquid`). Patterns should anchor on a path boundary to
avoid substring collisions (`/(^|\/)pagefly[-./]/i`, not `/pagefly/i`, so a file
merely mentioning "pagefly" in a longer word does not match).

### 4.2 Lookup function

Add to `app-lookup.server.ts`:

```ts
export function identifyAppFromFilename(filename: string): AppSignature | null {
  for (const sig of APP_SIGNATURES) {
    if (!sig.filePatterns) continue;
    for (const pattern of sig.filePatterns) {
      if (pattern.test(filename)) return sig;
    }
  }
  return null;
}
```

Returns the full `AppSignature` (not just the name) so callers can read
`isTracker`. Keep the KEEP-IN-SYNC contract noted at the top of both files.

### 4.3 Precedence rule (the crux)

The filename identifies the app that OWNS the file (the app whose uninstall
orphaned it). The inline/URL/snippet signal identifies what the code REFERENCES.
When they disagree we must not blindly prefer either. Rule:

> Prefer the filename-owner app over the content-derived app ONLY when the
> content-derived app is a generic tracker (`isTracker === true`) or is null.
> When the content resolves to a specific NON-tracker app, keep the content
> attribution (it is the more precise signal for a nested widget).

Rationale for the tracker carve-out: trackers (fbq/ga/gtag -> Facebook Pixel,
GA, GTM; all already flagged `isTracker: true`) are libraries that many apps
embed. A tracker call inside `spreadr.liquid` is Spreadr using Facebook Pixel,
not a Facebook Pixel leftover. But a specific non-tracker match (e.g. a Judge.me
review widget nested inside an EComposer section file) is a genuine second app's
code embedded in the first app's file, and the more specific match should win.

Decision table (content attribution vs filename attribution):

| Content-derived app            | Filename-owner app   | Result                                 |
| ------------------------------ | -------------------- | -------------------------------------- |
| null                           | Spreadr              | Spreadr                                |
| Facebook Pixel (`isTracker`)   | Spreadr              | Spreadr (override)                     |
| Google Analytics (`isTracker`) | PageFly              | PageFly (override)                     |
| Judge.me (non-tracker)         | EComposer            | Judge.me (keep content; nested widget) |
| EComposer                      | EComposer            | EComposer (agree)                      |
| Facebook Pixel (`isTracker`)   | null (no file match) | Facebook Pixel (unchanged)             |

NOTE: the first row (`null` content + file match -> file-owner) is the
helper's spec-compliant behavior, but the SCRIPT/STYLE detectors gate it OFF at
the call site (see 4.4.2): a null content match preserves the original skip and
does NOT manufacture a finding. `resolveAttribution` itself keeps the null row
intact; only its callers decide whether to act on it. `detectGhostPixels` is
unaffected — its content (a `TRACKING_PATTERNS` appName) is never null.

Optional description enrichment (nice-to-have, not required): when overriding,
append the tracker context, e.g. `Inline tracking pixel left by Spreadr (calls
Facebook Pixel)`. Keeps the diagnostic value without the misattribution.

### 4.4 Touch points

Apply the precedence in each detector that currently attributes via content:

1. `detectGhostPixels` (`:1388`). Highest impact. After matching a
   `TRACKING_PATTERNS` entry, check `identifyAppFromFilename(file.filename)`; if it
   returns a non-tracker signature, use its `appName` (the current tracker entry
   is `isTracker` by definition, so it always yields to a file-owner). Adjust the
   dedup: today it dedups by `tracker` per file; keep that (still one finding per
   tracker per file) but the emitted `appName` becomes the file owner.
2. Script / stylesheet detectors (`:412`, `:460`). Wrap the existing
   `identifyAppFromUrl(url) ?? identifyAppFromCode(url)` result in the precedence
   check against the filename owner. The filename override is applied ONLY to
   REFINE a non-null content match (tracker -> owning app). A null content match
   (unrecognized URL) preserves the ORIGINAL skip (`if (!contentApp) continue;`)
   and does NOT manufacture a finding from the filename alone. Rationale: broad
   filePatterns (e.g. EComposer's `ecom-*`) plus a still-installed app would
   otherwise flag every unrelated external `<script>`/`<link>` in that app's
   files as a false positive. Gate the null-content row at the call site, before
   calling `resolveAttribution`.
3. Leave snippet-name, hreflang, and json-ld detectors as-is unless a concrete
   misattribution surfaces; those signals are already app-specific. (Surgical:
   only touch what the evidence implicates.)

Recommended: implement the precedence once as a small helper
`resolveAttribution(contentApp: string | null, filename: string): string | null`
in `app-lookup.server.ts` and call it from each site, to keep the rule DRY and
single-sourced.

## 5. Signatures to add / update (coordinates with gc-rmb, gc-ohn)

- Spreadr (gc-rmb): `appName: "Spreadr"`, `filePatterns: [/(^|\/)spreadr[-.]/i]`,
  `scriptPatterns: [/SpreadrClick/, /spreadrRedirectURL/, /SpreadrLink/]`,
  `isTracker: false`. Amazon affiliate/importer app.
- PageFly: already present. Add `filePatterns: [/(^|\/)pagefly[-.]/i]` so its
  gtag-loader leftovers attribute to PageFly.
- EComposer: add `filePatterns: [/(^|\/)ecom[-_.]/i]` (matches `ecom-*.liquid`,
  `ecom_theme_helper.liquid`, `ecom.liquid`). Also fold in gc-ohn (add
  `cdn.ecomposer.app` to cdnDomains).

## 6. Compatibility

- Scan-differ: `fingerprintFinding` = `filename + findingType +
normalize(codeSnippet, lineNumber)`. `appName` is NOT in the fingerprint, so
  re-attribution keeps a finding's identity. Verified: the first post-deploy scan
  reports these as `persisted`, not a spurious `resolved` + `new` pair. This is a
  hard requirement and must have a regression test.
- `IgnoredFinding` APP-scope suppression keys on `Finding.appName`. A merchant who
  bulk-ignored "Facebook Pixel" will see the re-attributed Spreadr findings
  reappear (the APP ignore no longer matches). INSTANCE-scope (fingerprint-based)
  ignores are unaffected. Accepted behavior change: re-surfacing is arguably
  correct, and it is documented here. Call it out in the PR description.

## 7. Testing

- Unit (app-lookup): `identifyAppFromFilename` matches Spreadr/PageFly/EComposer
  paths and rejects near-miss substrings.
- Unit (precedence helper): full decision table in 4.3, including the Judge.me
  nested-widget "keep content" case and the null-content case.
- Detector (scan-engine): feed the d4c4c4 file fixtures; assert Spreadr and
  PageFly attribution; assert no change to genuinely-tracker-only leftovers in a
  non-app-owned file (e.g. a raw gtag in `theme.liquid` stays "Google Analytics").
- Differ regression: two consecutive scans of the same fixture across the
  attribution change produce `resolved=0, new=0, persisted=N`.

## 8. Rollout

Standard: additive schema-less code change (no DB migration; `filePatterns` is a
static array). Ships via main -> Railway auto-deploy. No flag needed; correctness
fix. Verify post-deploy by re-scanning the dev store (nw-dev-store-2) or awaiting
the next real merchant scan and checking `Finding.appName` for `spreadr*` files.

## 9. Decisions (locked 2026-09-17)

1. RESOLVED - Enrich descriptions. On override, emit `Inline tracking pixel left
by Spreadr (calls Facebook Pixel)` (keep the tracker context, fix the app). The
   `resolveAttribution` helper returns both the resolved app and the overridden
   tracker name so the detector can compose this string.
2. RESOLVED - Keep content match for nested specific (non-tracker) apps. Judge.me
   nested in an EComposer file attributes to Judge.me. File-owner overrides only
   generic trackers and null, per the 4.3 rule. No change needed to the design.
3. RESOLVED - Evidence-driven scope only. Add `filePatterns` for Spreadr, PageFly,
   EComposer in this change. Do NOT add speculative patterns for Shogun/GemPages/
   others; add them when a scan implicates them.

```

```
