# Spike gc-dcyh: pirated ("nulled") theme check + an uncertain finding category

Date: 2026-10-21. Code read on `origin/main` = `dce2101` (prod). Research only: no code, flag or prod changes.
Trigger: Community t/701013. A merchant's designer installed a pirated Shrine Pro. The live copy reports Shrine PRO 1.0.4 and loads an obfuscated `shrine.null.js` (SaifUrRehman, in-thread; UNVERIFIED by us, we did not fetch the store).

## TL;DR

- GhostCode can't reliably tell that a theme is pirated. It CAN reliably tell that a theme or app file contains code written to be unreadable (obfuscated). That is the honest, useful signal, because obfuscation is how hidden malicious code is usually disguised, and it's exactly what a clean GhostCode scan currently says nothing about.
- `themeStoreId` (the obvious "was it bought?" field) is useless here. Shopify documents it as set only for Shopify-made themes installed from the Theme Store, so every legitimately bought third-party theme reads null too.
- Shopify already polices piracy of Theme Store themes (the "Action required: licensing issue" emails). The gap is themes sold outside the Theme Store (Shrine is sold direct) and, above all, the security angle.
- Recommendation: Option C, built in two phases. Phase 0 is a dark detector that writes only to ops telemetry, to measure false positives on real stores (size S). Phase 1 surfaces a new uncertain FindingType `SUSPICIOUS_CODE` with a "Needs a look" certainty label, shown on all plans and never paywalled. A filename-marker signal (`*.null.js`, "nulled") is folded in as the strongest reason. Phase 1 is size M to L. Start Phase 1 after release 2 deploy B.
- Batch with it: gc-xtno (security banner LOWs) and gc-n3in (Sidekick security label). Both touch the same files and are still valid. Don't batch gc-3y89 (half of it lands in summary-email, owned by release 2 slice 5), gc-ui45 (a separate worker service), gc-c4k (a different lane) or gc-f1np (watch only).

## 1. Signals

| Signal | What we read today | Precision / FP risk | Recall | Cost | New scope/fetch? |
|---|---|---|---|---|---|
| `theme_info` in `config/settings_schema.json` (name, version, author) | Already read: `app/lib/theme-info.ts:95-111` (`readThemeInfo`), stored on `Scan.themeInfo`. `theme_documentation_url` is NOT read today. | Not a piracy signal on its own: a nulled copy keeps the vendor's `theme_info`. Useful only to NAME the theme in copy ("Shrine PRO 1.0.4"). | n/a | Free | No |
| Admin `themeStoreId` | NOT queried. `MAIN_THEME_QUERY` reads `id name updatedAt` (`app/services/theme-fetcher.server.ts:59-69`); `ALL_THEMES_QUERY` adds `role` (`:71-87`). The field exists on `OnlineStoreTheme` (Int, same `read_themes` scope; shopify.dev). | Very poor. The REST doc says: "A unique identifier applied to Shopify-made themes that are installed from the Shopify Theme Store ... Returns null if the store's theme isn't made by Shopify, or if it wasn't installed from the Theme Store." So every bought Prestige, Impulse or Turbo reads null, and so does every theme pushed with Shopify CLI. Community t/622124 also reports a store-installed theme losing its Theme Store link. | Near zero for third-party themes | One field | No new scope |
| Asset filename markers (`*.null.js`, `nulled`, `crack`, `warez`) | All theme filenames are listed by the files query (`theme-fetcher.server.ts:88-108`). Asset JS bodies are already scanned for MALICIOUS_SCRIPT (`scan-engine.server.ts:545-556`, `isMaliciousScanOnlyFile`). | High precision when present ("null" in a theme filename has no innocent reading we know of; UNVERIFIED across real themes). | Tiny: one rename defeats it. Only evidence is one thread. | Free | No |
| Obfuscated JS heuristics | Asset JS bodies are in memory during the scan (same path as above). Files over 1 MB are size-skipped (`scan-engine.server.ts:212`); MALICIOUS_SCRIPT still scans them (`finding-classification.ts:284-287`), so the same exception would be needed. | Promising but unproven on real paid themes. Local test (below): 0 of 44 normal files flagged; 4 of 5 obfuscated samples flagged. Risk: some theme and app vendors obfuscate legitimately to protect licensing; Shrine's own licensed copy may be obfuscated too (UNVERIFIED). Hence "needs a look", never "malicious". | Medium: catches common obfuscators (javascript-obfuscator `_0x` names, Dean Edwards packer, hex/charcode + eval). Misses a plain `atob` loader (by design, to keep FPs down). | Linear regex pass over JS already in memory | No |
| Stripped or bypassed licence checks | Not feasible. Theme Store licensing is enforced by Shopify server-side (the licensing emails), not in theme code. Shrine handles licences through a companion app (Debutify blog). How a licensed Shrine copy calls home is UNVERIFIED. | n/a | n/a | Per-vendor reverse engineering | Would mean fetching vendor endpoints: no |

Local heuristic test (scratchpad, not committed). Negatives: Dawn `assets/*.js` (36 files) + 8 common minified libraries from cdnjs (jQuery, Swiper, Flickity, Lodash, GSAP, Vue, ReactDOM, crypto-js). Positives: Dawn `global.js` through javascript-obfuscator v4 (default and base64 string array), a packer sample, a charcode+eval sample, a plain atob loader.

Rule: flag if `eval(function(p,a,c,k,e,` (packer), or >= 20 `_0x[0-9a-f]{4,6}` identifiers, or hex escape density >= 5 per 1,000 chars, or `fromCharCode(n,n,n` together with `eval`/`atob`.

Result: negatives 0/44 flagged; positives 4/5 (the plain atob loader is missed). Caveat: no paid-theme bundles or app-written asset files in the corpus, which is why Phase 0 must measure on prod.

## 2. Prevalence and what nulled themes contain

- Community crawl (10,335 threads, Oct 2025 onward, `shopify_apps.db`): only 3 threads mention nulled, unlicensed or pirated themes. They are t/701013 (this one), t/576974 (a store termination where a reply blames unlicensed themes, speculative) and t/622124 (a missing Theme Store link on a bought theme). So it's rare in merchant talk, but the threads are high-stakes.
- Supply: nulled Shrine Pro builds (1.2.0 to 1.4.3) are openly sold on Gumroad ("Shrine Pro 1 4 3 nulled", argylegame.gumroad.com).
- Shopify detects unlicensed Theme Store themes and emails merchants ("(Action required) Your Shopify store may be using an unlicensed theme", community t/274853; help.shopify.com theme licensing). A reported bypass of that check circulates (community.shopify.dev t/21561, Aug 2025, no staff reply).
- What they contain: general sources say nulled software often carries backdoors or malware (cleverence.com, securityscientist.net). We found no public teardown of a nulled Shopify theme's payload (UNVERIFIED). The jsdeliver.cloud case in t/600137 was on a Shrine store, but that thread ties it to a rogue app, not the theme.

## 3. The uncertain category

### How a finding type flows today

The last security type added (APP_INCIDENT_ADVISORY, gc-14x5) touches 23 app files and about 30 test files. The ones that matter here:

- Enum: `prisma/schema.prisma:729-851` (`FindingType`); `Severity` is only HIGH/MEDIUM/LOW (`:853-857`). A new type needs a migration (self-migrating deploys).
- Confidence: `app/lib/finding-classification.ts:99` (HEURISTIC set), `:182` (SIGNATURE set), `:213` `getFindingConfidence`. That axis is about app attribution, not certainty (see the comments at `:120-131`), and a drift test makes the two sets partition the enum. So "uncertain" is a NEW axis; don't overload this one.
- Security surfaces: `app/lib/security-risk.ts` (banner views; MALICIOUS shown even when ignored, advisories honour ignores), `app/components/SecurityRiskBanner.tsx`, `app/services/security-risk.server.ts`, `app/lib/findings-tile.ts`, `app/lib/top-findings.ts` (Start here), `app/lib/theme-health.ts` + `app/services/theme-health.server.ts` (checklist row), `app/lib/finding-safety.ts` (badge), `app/lib/finding-consequence.ts` (lane), `app/lib/finding-remediation.ts` (steps), `app/lib/finding-type-labels.ts`.
- Other surfaces: `app/services/sidekick-scan-summary.server.ts:229` (impact label), `app/services/change-log.server.ts` (release 2 rows), summary email counts, PDF/CSV/JSON exports (`app/lib/scan-report-pdf.server.tsx` and the scan route), `app/lib/free-preview.ts` / `scan-limits.ts` (plan gating: security is never paywalled), ignores.
- Copy rules: "GhostCode" one word, "leftover code" as the plain phrase, no em dashes; read-only (never "remove", "fix" or "clean" as GhostCode actions).

### Options

**A. New FindingType `SUSPICIOUS_CODE` with a "Needs a look" label (per file).** One finding per asset file that trips the heuristic or the filename marker. Severity MEDIUM. A new certainty field in the type metadata (e.g. `certainty: "confirmed" | "needs-review"` in `finding-type-labels.ts` or a small new lib), rendered as an amber "Needs a look" badge, not the red security banner. All plans, full detail, never paywalled. Honours ignores (unlike MALICIOUS: a merchant who confirms the vendor wrote it can dismiss it).
- Pros: per-file location with an "Open in code editor" link; flows into change log, exports and Sidekick like every finding; ignorable.
- Cons: biggest change set (enum + migration + ~20 files + tests); needs an FP measurement first.
- Effort: M to L (about 2 agent days incl. audit).

**B. Theme health checklist row only ("Theme source").** No FindingType: the detector adds `suspicious: {reasons, files}` to `Scan.themeInfo` (JSON, no migration) and `theme-health.ts` renders a "Needs a look" row.
- Pros: small (S to M); no enum or migration; the checklist already handles "Not checked" and amber states; Sidekick's theme health summary carries it.
- Cons: no per-file card, no ignore, no change-log row, not in exports or email counts. Easy to miss: Home hides issue rows behind lanes (theme-health design note 10-12).

**C. Recommended: A as the mechanism, with B-style theme naming, built in two phases.**
- Phase 0 (dark, S): a pure detector module (`app/lib/suspicious-code.ts`) run inside the existing asset pass. It writes counts and reasons to `scan_signal` metadata only (ops digest), behind a flag. Nothing reaches merchants. Run 2 to 4 weeks to measure FP rate across real paid themes and app asset files (the same playbook as gc-ui45 and the dark-data week).
- Phase 1 (M to L): ship `SUSPICIOUS_CODE` as in A. Its card names the theme from `theme_info` when the file is a theme asset ("This file is part of Shrine PRO 1.0.4"). A filename marker is listed as the first reason.
- Why: per-file honesty and ignore support (A) without betting the merchant's trust on an unmeasured heuristic.

### Copy drafts (Phase 1)

Finding card title: **Unreadable code, needs a look**

Card body (obfuscation):
> `assets/shrine.null.js` contains code written so people can't read it (obfuscated). Some theme and app developers do this to protect their work. It is also the usual way hidden malicious code is disguised. GhostCode can't tell which this is. Check that this file came from your theme's developer or from an app you use. GhostCode never changes your theme.

Extra line when a filename marker matched:
> The file name includes "null", a label often used on pirated copies of paid themes. Pirated themes can carry hidden code and don't get the developer's updates. If you bought this theme, you can mark this as checked.

Theme health row (Phase 1, a summary of the findings above): label **Unreadable code**, status **Needs a look** (amber), detail:
> 1 file in Shrine PRO 1.0.4 has code written to be unreadable. GhostCode can't confirm what it does.

Sidekick impact label: "Needs a look (unreadable code)". Never "Security risk" or "Malicious".

Never say: "pirated", "unlicensed" or "stolen" as a verdict about the merchant's store; "malicious"; "remove"/"fix" as GhostCode actions.

## 4. Batch fit (checked against origin/main dce2101)

| Bead | Still valid? | Shares files with gc-dcyh Phase 1? | Batch? |
|---|---|---|---|
| gc-xtno (security banner LOWs) | Yes. Item 4: `finding-safety.ts:54` still maps MALICIOUS_SCRIPT to `safe-to-remove`, rendered as "Likely safe, confirm app removed" (`:154`). Item 1: `advisoryReportUrl` still wired at `app/routes/app.scans.$scanId.tsx:115,584,915,1475`. | Yes: finding-safety.ts, security-risk.ts, SecurityRiskBanner, scan route | YES |
| gc-n3in (Sidekick label) | Yes. `sidekick-scan-summary.server.ts:229` uses `laneLabelForLane`; the MALICIOUS lane label is "Still tracking you" (`finding-consequence.ts:96`). The bead says ~line 218; it's now 229. | Yes: the new type needs a Sidekick label decision anyway | YES |
| gc-3y89 (runtime malicious LOWs) | Yes (gc-0htk is in dce2101). | Partly: item 6 (theme-health.ts) overlaps; item 7 (summary email count) touches `summary-email.server.ts`, owned by release 2 slice 5 | Only items 1-4, 6, 9, 10. Defer 5, 7, 8 until after release 2 |
| gc-f1np (watch) | Yes, a data-only watch | No | No |
| gc-ui45 (checkout safety worker) | Yes | No (separate Railway service). Later, the gc-dcyh detector could also run on the worker's captured script bodies | No, separate batch |
| gc-c4k (signature FP audit) | Yes (back-in-stock fixed in 482fb4f; the rest unaudited) | No (app-signatures lane) | No |

Release 2 overlap (spec `docs/specs/what-changed-release2.md` §11; branch `feat/gc-rrh4-change-log` is still just origin/main plus a handoff):
- Phase 1 touches `app/routes/app._index.tsx` (slice 4), `soft-launch-flags.server.ts` (slice 3 adds a flag), `change-log.server.ts`/`change-log-copy.ts` (slices 2-3; the new type needs a change-log row label) and possibly `summary-email.server.ts` (slice 5).
- Phase 0 touches `scan-engine.server.ts`, a new lib, and one `scan_signal` field in `inngest/functions/scan-theme.ts`, which slices 1, 2 and 5 also edit (a small, mechanical conflict).
- So: Phase 0 can go now if it keeps its `scan-theme.ts` edit to one metadata field. Phase 1 should wait for deploy B.

## 5. Privacy and legal

- Data use doesn't change for Phase 0: asset JS is already read in memory for MALICIOUS_SCRIPT. Phase 1 stores a new finding (file, line, short snippet) like other findings.
- Pre-existing policy drift, worth fixing in the same policy pass: `ghost-code/privacy.html:38` lists theme files as "Liquid templates, sections, snippets, and layout files ... to scan for orphaned code". The scan has long also read `assets/*.js`, JSON templates, `config/settings_data.json`, locales (`scan-engine.server.ts:545-556`) and `config/settings_schema.json` (theme-info), and uses them for malicious code and theme facts, not only orphaned code.
- Phase 1 needs a policy line: Section 2 (`privacy.html:105-110`) for what is stored, and the Sidekick paragraph (`:119`), which enumerates the summary's contents.
- Terms: no change if the copy never asserts piracy as a fact (see "Never say"). Flagging a merchant's theme as "pirated" could be wrong (a vendor's own obfuscation) and accusatory. The copy above treats it as a question.

## Effort and recommendation

1. Phase 0 now (S, about half an agent day plus audit): `app/lib/suspicious-code.ts` (pure, tested with the positive and negative fixtures above, plus real minified app bundles), a call in the asset pass, `scan_signal.suspiciousCode = {files, reasons}`, flag `SUSPICIOUS_CODE_SIGNAL_ENABLED`, and an ops digest line. No merchant surface, no policy change.
2. After 2 to 4 weeks of data and release 2 deploy B: Phase 1 (M to L) plus gc-xtno plus gc-n3in as one batch, with an adversarial audit, then a policy update (Section 2 + Sidekick + the line 38 drift) published before the flag goes on.
3. Drop `themeStoreId` as a signal. Don't try licence-check detection.

## UNVERIFIED

- That the live t/701013 store loads `shrine.null.js` and that it is obfuscated (merchant-reported in-thread; we did not fetch it).
- Whether a licensed Shrine Pro also ships obfuscated JS (it would make Shrine stores false positives by design; the "Needs a look" framing covers it).
- How Shrine's licence check works (a companion app per Debutify's guide; no primary source).
- FP rate on real paid themes and app-written asset files (corpus here is Dawn plus 8 libraries only).
- Whether "null" in a theme asset filename ever occurs innocently.
- What payloads nulled Shopify themes actually carry (no public teardown found).

## Sources

- shopify.dev REST Theme resource, `theme_store_id`: https://shopify.dev/docs/api/admin-rest/latest/resources/theme
- shopify.dev GraphQL OnlineStoreTheme (`themeStoreId`, `prefix`, `role`): https://shopify.dev/docs/api/admin-graphql/latest/objects/OnlineStoreTheme
- Shopify licensing emails: https://community.shopify.com/t/action-required-your-shopify-store-may-be-using-an-unlicensed-theme/274853 ; https://community.shopify.com/t/i-got-an-email-which-says-to-take-action-regarding-my-shopify-stores-theme/368007
- Licensing bypass report: https://community.shopify.dev/t/theme-licensing-bypass/21561
- Prestige licensing (Theme Store only, one store): https://prestige-theme.helpscoutdocs.com/article/381-theme-licensing-and-transfers
- Shrine sold direct, companion app licensing: https://debutify.com/blog/guide-to-shrine-theme-pricing-features
- Nulled Shrine Pro listings: https://argylegame.gumroad.com/l/Shrine-Pro-1-4-3-nulled
- General nulled-software risk: https://www.cleverence.com/articles/shopify-dev-documentation/malware-codes-in-my-theme-code-5823/ ; https://answers.securityscientist.net/q/1298/why-does-using-nulled-software-pose-a-security-risk
- Community threads: t/701013, t/622124, t/576974, t/600137
