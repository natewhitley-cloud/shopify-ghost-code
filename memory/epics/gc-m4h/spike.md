# gc-m4h.1 Spike — DANGLING_REFERENCE finding class (v1 design)

Read-only spike. All `file:line` citations verified against current code at HEAD
(`5e37407`) on 2026-09-11. Admin API version in use: **2026-04**
(`app/shopify.server.ts:28`, `shopify.app.toml:12`).

DANGLING_REFERENCE = theme code that **statically** references a shop entity
(product / collection / page / menu) that no longer exists in the Admin.
Distinct from GHOST_* (app-uninstall-origin markup) and SETTINGS_DRIFT (stale
section-file refs in `settings_data.json`).

---

## A) Pattern inventory

Theme code hardcodes an entity handle in two broad shapes: (1) storefront **URL
paths** in HTML `href` / Liquid strings, and (2) Liquid **object lookups** by
literal handle. The existing static-JSON-LD extractor already parses
`/products/{handle}` from a URL — see `extractProductIdentity` at
`app/services/scan-engine.server.ts:1191` (`/\/products\/([^/?#]+)/`), which is
the exact discipline to generalize.

| # | Pattern (extraction sketch) | Entity | Notes |
|---|---|---|---|
| P1 | `href\s*=\s*["']\/products\/([a-z0-9][a-z0-9-]*)(?:[/?#"']\|$)` | product | handle = group 1, lower-cased. Strip query/anchor/`.js`/`.json` suffix. |
| P2 | `href\s*=\s*["']\/collections\/([a-z0-9][a-z0-9-]*)(?:[/?#"']\|$)` | collection | Ignore `/collections/all` (reserved) and `/collections/{h}/products/{ph}` — a collection+product path; parse the collection segment only. |
| P3 | `href\s*=\s*["']\/pages\/([a-z0-9][a-z0-9-]*)` | page | |
| P4 | Liquid object access with a **string literal**: `all_products\[\s*['"]([a-z0-9-]+)['"]\s*\]` | product | `all_products['old-widget']` |
| P5 | `collections\[\s*['"]([a-z0-9-]+)['"]\s*\]` | collection | `collections['summer-sale']` |
| P6 | `pages\[\s*['"]([a-z0-9-]+)['"]\s*\]` | page | `pages['about-us']` |
| P7 | `linklists\[\s*['"]([a-z0-9-]+)['"]\s*\]` **or** `linklists\.([a-z0-9_]+)\b` | menu | `linklists['footer']` / `{{ linklists.main_menu }}`. Dot form uses `_`; bracket form uses `-`. Resolve via menu handle. |

Extraction runs **per-line over Liquid/HTML template files** (same file scope as
`detectGhostTextFragments`, `app/services/scan-engine.server.ts:1284`), reusing
`buildSnippet(content, lineNumber)` and `lineNumberAtOffset` for evidence. Do
**not** scan `assets/*`, `config/*`, `locales/*` (already filtered upstream — see
scan-engine comment at line ~224). Collect distinct `(entityType, handle)` pairs;
one finding per hardcoded occurrence (file+line), but resolve each distinct
handle once (cache).

---

## B) FP rules — static literal vs dynamic ref (FP-CRITICAL, locked decision #1)

The reference implementation of this line is `extractStaticProductCandidates`
(`app/services/scan-engine.server.ts:1229`): it drops any JSON-LD block that
contains a Liquid tag (`if (LIQUID_TAG_RE.test(blockContent)) continue;`, line
1240) precisely because "a Liquid block is theme-rendered, not stale." Mirror
that discipline: **the captured handle must be a literal, and the surrounding
construct must not be Liquid-interpolated.**

Per-pattern FP guard (NEVER flag the dynamic forms):

- **URL patterns (P1–P3):** the path segment must match `^[a-z0-9][a-z0-9-]*$`
  with **no `{{`, `{%`, `}`, `.`, `|`, or whitespace** inside it. Exclude:
  - `href="/products/{{ product.handle }}"`, `/collections/{{ collection.handle }}`
  - `href="{{ product.url }}"`, `{{ routes.* }}`, `{{ ... | link_to }}`
  - relative/loop-built paths: `href="/products/{{ item.handle }}"`.
  Rule: reject the whole match if the `href` value contains `{{`/`{%`. Only a
  fully-literal path survives.
- **Liquid object patterns (P4–P7):** the bracket/dot key must be a **quoted
  string literal (P4–P6) or a bare word (P7 dot-form)** — NEVER flag when the key
  is a variable or filter output. Exclude:
  - `all_products[product.handle]`, `collections[section.settings.collection]`,
    `pages[template.suffix]`, `linklists[section.settings.menu]`,
    `linklists[settings.menu_handle]` (the standard Dawn pattern — MUST be safe),
    `collections[some_var]`.
  Rule: the char class inside `[...]` is `['"][a-z0-9-]+['"]` only; anything with
  a `.`, a space, or no quotes is dynamic → skip. The dot-form `linklists.foo`
  is safe to treat as literal (Liquid resolves `linklists.foo` to the `foo`
  handle), but `linklists[var]` is not.
- **Comment/dead code:** severity is already auto-downgraded to LOW inside Liquid
  comments by `classifySeverity` (`isInsideLiquidComment`,
  `severity-classifier.server.ts:66`) — reuse it; no extra work.

Net: v1 flags only hardcoded literals. Every context-object / loop / settings
form is excluded by construction, matching the JSON-LD-price audit's static bar.

---

## C) v1 scope confirmation (4 entity types)

| Entity | Statically detectable? | Admin-resolvable by handle? | Scope | Verdict |
|---|---|---|---|---|
| product | Yes (P1, P4) | Yes — `products(query:"handle:...")` already used at `jsonld-price-audit.server.ts:207` | `read_products` | **KEEP** |
| collection | Yes (P2, P5) | Yes — `collections(first:2, query:"handle:...")` (same search-syntax pattern) | `read_products` (collections live under the Products scope group) | **KEEP** |
| page | Yes (P3, P6) | Yes — reuse `fetchPages` (`content-fetcher.server.ts:80`), build a handle Set | `read_content` | **KEEP** |
| menu | Yes (P7) but rarer + riskiest | Yes — `menus(first:250){nodes{handle}}` build a Set | `read_online_store_navigation` | **KEEP with caution — see risk R2; deferral is a live option** |

All four are doable. Menu is the weakest link: hardcoded `linklists['handle']`
is uncommon in modern themes (Dawn/OS 2.0 drive menus through
`section.settings.menu`, which is dynamic and correctly excluded), so the pattern
will rarely fire — but when it does it is a real static ref. Recommendation:
ship menu with the narrowest pattern (P7), or defer to v2 if the orchestrator
wants to minimize surface. No scope-declaration work needed — all three optional
scopes are **already declared** in `shopify.app.toml:39`
(`read_translations, read_products, read_content, read_online_store_navigation`).

---

## D) Admin-API resolver design

**probeScope pattern (confirmed):** `probeScope(admin, query, label)` at
`app/lib/scope-check.server.ts:93` runs a tiny query and returns `false` ONLY on
a genuine ACCESS_DENIED, throwing `TransientScopeCheckError` on anything else so
the Inngest step retries (never a false-clean). The three probes we need already
exist — **reuse, do not add:**
- `hasProductScope` — `product-fetcher.server.ts:134` (`{ products(first:1){nodes{id}} }`) → products **and** collections.
- `hasContentScope` — `content-fetcher.server.ts:60` (`{ pages(first:1){nodes{id}} }`) → pages.
- `hasNavigationScope` — `redirect-fetcher.server.ts:31` (`{ urlRedirects(first:1){nodes{id}} }`) → menus.

**New fetchers/resolvers to add** (follow the per-handle lookup + cache + budget
model of `jsonld-price-audit.server.ts`, which is the closest analog — targeted
handle lookups, not fetch-all, because product/collection catalogs are large):

Collection existence (new `collection-fetcher.server.ts`, or fold into the
dangling-ref service):
```graphql
query CollectionByHandle($query: String!) {
  collections(first: 2, query: $query) { nodes { handle } }
}
# variables: { query: `handle:"${handle}"` }  → exists iff exactly one node
```
Product existence: reuse the `products(first:2, query:"handle:...")` shape
already in `jsonld-price-audit.server.ts:207` (drop the variant/price subtree —
we only need `nodes { handle }`).

Pages: reuse `fetchPages(admin)` once, build `Set<handle>`. Cheap (capped 250).

Menu existence (new):
```graphql
query Menus($first: Int!, $after: String) {
  menus(first: $first, after: $after) { nodes { handle } pageInfo { hasNextPage endCursor } }
}
```
Fetch all (stores have few menus), build `Set<handle>`; a P7 ref is dangling iff
its handle is absent.

Use the same `escapeSearchValue` quoting (`jsonld-price-audit.server.ts:240`) and
`runQuery`-style THROTTLED/ACCESS_DENIED handling. Cap distinct lookups per scan
(mirror `MAX_LOOKUPS = 50`, line 56) and set `skipped=true` if the cap truncates.

**Graceful degradation (locked decision #5).** Gate each entity type on its own
scope. When a scope is absent, **do not emit any DANGLING_REFERENCE for that
entity type** (never claim "deleted" from an unchecked entity), and continue
checking the types whose scope is present. Because there is ONE FindingType and
the differ's skip guard is FindingType-granular (see E/F), the precise rule is:
**mark DANGLING_REFERENCE as `skipped` for `skippedCategories` iff the theme
contains at least one static ref of a type whose scope is absent.** This prevents
the differ from false-resolving refs we could not re-check, without suppressing
the FindingType when scopes are fully present. This is the central design tension
— see risk R1.

---

## E) FindingType + evidence shape

### Verified count: **28 → 29** (epic's claim is CORRECT)
Counted directly from `prisma/schema.prisma:203` enum FindingType: 28 members
(GHOST_SCRIPT … DUPLICATE_LIBRARY). Adding `DANGLING_REFERENCE` = 29.

### Exhaustive list of maps/switches gc-m4h.2 MUST touch
Grouped by whether the TS compiler forces the edit:

**Compiler-enforced `Record<FindingType, …>` (build breaks until added):**
1. `prisma/schema.prisma:203` — add `DANGLING_REFERENCE` to `enum FindingType` (+ new migration; enum add is additive/reversible — safe per the self-migrating-deploy note).
2. `app/services/severity-classifier.server.ts:18` — `DEFAULT_SEVERITY`. (Recommend `MEDIUM`: a broken link is customer-visible but not a security/tracking harm.)
3. `app/lib/finding-consequence.ts:126` — `CONSEQUENCE_MAP`. (Recommend `primary: "customers-see-it"`, `secondary: ["discoverability"]`, `urgency: "act-now"` for product/collection/page 404s; `agentic: true` — broken links degrade Google/AI crawl.)
4. `app/models/finding.server.ts:107` — `typeCounts` in the summary builder.
5. `app/models/finding.server.ts:204` — `typeCounts` in `getTypeCountsForScan`.

**NOT compiler-enforced — guarded by drift test OR silent fallback (MUST add manually):**
6. `app/lib/finding-classification.ts:96` — add to `HEURISTIC_FINDING_TYPES`. **A drift test enforces this** (`tests/lib/finding-classification.test.ts:154`, "classifies every FindingType enum member in exactly one tier"): every enum member must be in exactly one of signature/heuristic. DANGLING_REFERENCE has no app-signature match → HEURISTIC. (Semantics note: the heuristic/signature axis is about app-attribution, not certainty; Admin-confirmed existence is actually high-certainty. Flag for product owner if the "Heuristic" badge misrepresents confidence — see risk R3.)
   - `VISUAL_FINDING_TYPES` (line 12) — optional; add if a broken link should count as visually-impactful. Recommend **not** adding (a dead link is not injected visible markup).
   - `CROSS_FILE_FINDING_TYPES` (line 203) — **do NOT add**; this is an API-based per-file detector, not a cross-file pass.
7. `app/routes/app.scans.$scanId.tsx:101` — `FINDING_TYPE_LABELS` (`Record<string,string>`, not enforced). Add e.g. `DANGLING_REFERENCE: "Broken Links"`. **Load-bearing:** the type-filter loader validates `rawType in FINDING_TYPE_LABELS` (line 361), so the filter chip is invisible until added.
8. `app/lib/finding-remediation.ts:40` — `REMEDIATION` (`Record<string,…>`, falls back to generic). Add a `howTo` (fix or remove the broken link) and an agentic `impact` (broken product/collection links cost crawl budget and drop you from AI answers).

**Tests that assert exhaustiveness (will fail / need a case):**
`tests/lib/finding-classification.test.ts` (drift guard), `finding-consequence.test.ts`, `finding-remediation.test.ts`, `finding.server.test.ts`, plus new unit tests for the detector + resolvers and a `scan-theme.test.ts` wiring case.

### Evidence shape — NO schema JSON column exists
The `Finding` model (`prisma/schema.prisma`) has only:
`filename, lineNumber, codeSnippet, findingType, severity, appName?, description`.
There is **no `evidence`/`metadata` JSON column.** So locked decision #3's "entity
subtype carried in the finding's evidence" must be encoded into the **existing
string fields** (recommended — keeps v1 migration to just the enum value) rather
than a new column:

- `findingType` = `DANGLING_REFERENCE` (all subtypes share it — decision #3).
- `filename` / `lineNumber` = the theme file + line of the hardcoded ref.
- `codeSnippet` = `buildSnippet(...)` (the offending line + context) — feeds the differ fingerprint.
- `description` = carries the **subtype + matched literal + verdict**, e.g.
  `Broken collection link: /collections/summer-sale — this collection no longer exists (verified via Admin API).`
  Parse-free for humans; the subtype word ("product/collection/page/menu") is the
  first token after "Broken ".
- `appName` = leave undefined (no app attribution) OR overload as a structured
  subtype tag (`"collection"`) if the UI wants to badge subtype without parsing
  `description`. **Recommend `appName = subtype`** — cheapest structured handle,
  already rendered in the UI, and it does not participate in the differ
  fingerprint (which keys on `filename\0findingType\0normalizedSnippet`, verified
  at `scan-differ.server.ts:130`).

Resolver verdict is binary (exists / does-not-exist); only does-not-exist becomes
a finding, so no verdict enum is needed in evidence — "does not exist" is implied
by the finding's existence. If v1 wants to record "unresolvable/ambiguous" it is
simply dropped (no finding), mirroring the JSON-LD audit's confident-only rule.

---

## F) Worker wiring (for gc-m4h.5)

`inngest/functions/scan-theme.ts`. The main scan runs the Liquid/HTML detectors
inside step 2 `fetch-and-scan` (line 214) via `scanThemeFilesInPool`. The
**static-ref extraction** (patterns P1–P7) belongs there, alongside how
`staticProductCandidates` are already collected in the pool and returned across
the step boundary (line 292-300) — return a tiny `danglingRefCandidates` array
the same way (handles only; a handful per theme, well under Inngest's 4MB limit).

The **Admin-API resolution + persistence** belongs in a NEW optional audit step
modeled on the **live-price audit step** (`product-price-audit`,
`scan-theme.ts:479`), NOT the generic `runAuditStep`, because — like the price
audit — it has extra preconditions (a candidate list + multiple per-entity scope
gates). Concretely, add a step after line 534 that:
1. returns `{findingCount:0, skipped:false}` if `danglingRefCandidates` is empty;
2. looks up shop + `unauthenticated.admin` (lines 493-498 pattern);
3. probes `hasProductScope` / `hasContentScope` / `hasNavigationScope` per the
   entity types actually present in the candidates;
4. resolves handles (D) and builds findings;
5. `persistAuditFindings({ findingType: FindingType.DANGLING_REFERENCE, ... })`
   (helper at line 85 — delete-by-type then create, idempotent);
6. returns `skipped` per the D rule.

Then thread it into `totalFindings` (line 536) and the `skippedCategories` array
(line 557) exactly like `jsonLdPriceResult`. Follow the price audit's
double-inert soft-launch (a `DANGLING_REFERENCE_LIVE_ENABLED` flag, line 482
pattern) so it ships INERT first — consistent with the JSONLD_LIVE_PRICE_ENABLED
precedent and the "live or it isn't / soft-launch before blocking gate" memory.

---

## G) Open risks / decisions for the orchestrator

**R1 (highest) — ONE FindingType spanning 3 scopes vs. the FindingType-granular
differ.** `skippedCategories` and the differ resolve/suppress at FindingType
granularity (`scan-differ.server.ts:200`, keys on `f.findingType`). With four
entity types under one type across three optional scopes, a merchant who grants
`read_products` but not `read_content` gets product/collection refs checked and
page refs not. The proposed precise-skip rule (D: mark skipped iff a ref of an
unscoped type is present) keeps correctness but means: in a mixed-scope store,
one missing scope suppresses resolved-detection for the *entire* type that scan.
Acceptable for v1; the alternative (per-subtype FindingTypes) was explicitly
ruled out by locked decision #3. **Decision needed:** confirm precise-skip is the
accepted behavior.

**R2 — menu detection value vs. FP risk.** P7 (`linklists['handle']`) is rare in
modern themes and the dynamic `linklists[section.settings.menu]` (Dawn default)
MUST be excluded. Low incremental value, small extra surface. **Decision:** ship
menu (narrow P7) or defer to v2? (Products/collections/pages carry ~all the
value.)

**R3 — confidence badge semantics.** The drift-guarded partition forces
DANGLING_REFERENCE into "signature" or "heuristic"; it has no app signature so it
lands in HEURISTIC ("invite merchant review"). But existence is Admin-verified,
so the finding is high-certainty — the "Heuristic" badge under-claims. Either
accept the mislabel, or (bigger) the confidence axis needs a third "verified"
tier. Recommend accept for v1, note for a future taxonomy pass.

**Secondary risks:** (a) `/collections/all` and nested `/collections/{c}/products/{p}`
paths need explicit handling in P2 (reserved handle; parse collection segment
only). (b) A handle that exists but is unpublished/hidden still resolves via
Admin → not dangling (correct: the link works for the merchant's published
scope; do not flag). (c) Locale-prefixed paths (`/en/products/x`,
`/fr-ca/collections/y`) — strip a leading `/{locale}` segment before matching or
they read as literal handles and miss. (d) API-version currency: queries sketched
against **2026-04**; `collections(query:)` and `menus` are stable there but the
impl must re-verify field availability at build time (memory: re-verify version
targets).

**No locked decision found INFEASIBLE.** All six hold. The only forced
adaptation: decision #3's "evidence" has no JSON column to live in, so subtype is
carried in existing `description`/`appName` fields (E) — a field-encoding choice,
not a conflict with the decision.
