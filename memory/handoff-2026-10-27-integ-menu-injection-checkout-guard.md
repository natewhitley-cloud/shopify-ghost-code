## Session Handoff: 2026-10-27, menu injection + checkout guard LIVE

### RESUME HERE (updated 2026-10-27 ~16:00Z; nothing in flight)
- **Prod = main 6584fb4** (Deploy run 40522563623, re-run after flag changes; smoke SHA-pinned green). Rollback code: redeploy b666948 / 92d0700 (all migrations additive).
- **LIVE flags (Railway prod):** MENU_INJECTION_LIVE_ENABLED=true (~13:45Z), STOREFRONT_GUARD_LIVE_ENABLED=true + STOREFRONT_GUARD_EMAIL_ENABLED=true (~14:41Z), RUNTIME_MALICIOUS_CHECK_LIVE_ENABLED=true (since 10-20). MENU_LABEL_SIGNAL_ENABLED still unset (gc-7gjj.2 dark data; set it to start the 2-week count for gc-7gjj.3).
  Guard rollback = unset the two STOREFRONT_GUARD_* flags, then `gh run rerun <latest Deploy run>` (a Railway var change redeploys WITHOUT .deploy-sha, so smoke SHA reads null until the GH Deploy is re-run).
- **Sidekick:** ghostcode-13 released (instructions guardrails for menu findings + liveStoreAlerts). Rollback: `shopify app release --version=ghostcode-12 --allow-updates`.
- **Legal:** data-integrity-suite 7cf063b (menus) + 64be32e (guard), both effective Oct 27 2026, live at legal.alpenglowsoftware.com/ghost-code/.
- **Resend:** click tracking was ON for notify.alpenglowsoftware.com (contradicted the policy); Nathan turned it OFF 10-27. Confirm by hovering links in the next GhostCode email (must not point at a Resend click domain).
- **First guard run 15:17Z:** 11 due, 4 ok, 5 paused_password, 2 unreachable:http_status (challenged=false), 0 incidents/emails/errors, ~2,160 Inngest steps/month projected (Inngest ~55% used per Nathan).
- **Scheduled:** local one-shot launchd `com.alpenglow.ghostcode-guard-24h` at 2026-10-28 08:30 MDT runs ~/shopify/ops-oneshots/guard-24h/run.sh: 24h guard review -> ops/daily-review/reports/2026-10-28-guard.md (line 1 GUARD OK / GUARD NEEDS NATHAN), note on gc-1q1s.1, macOS notification, then removes itself. If the Mac was off, run the script by hand.
- **Open beads:** gc-1q1s.1 (24h review result), gc-1q1s.8 (Tier 2 spike), gc-7gjj.3 (blocked on MENU_LABEL_SIGNAL data), parents gc-7gjj / gc-1q1s.
- **Dev store facts (gc-7gjj.5, gc-1q1s.1):** Admin API stores raw HTML in menu titles; menus query cost req 30/actual 5 at first=50; nw-dev-store-2 theme "test-data" (Dawn-derived) escapes header titles but sections/footer.liquid:91 prints link.title raw; empty /cart renders no checkout button.
- **Release 2** (~/shopify/gc-rrh4, feat/gc-rrh4-change-log) still needs a rebase on current main before slice 3; its 10-20 handoff is untracked at ~/shopify/gc-rrh4/memory/handoff-2026-10-20-release2-batch.md.

### Earlier (integration, pre-push) notes below

### (superseded) integration state
- **Branch `integ/gc-7gjj-gc-1q1s` (~/shopify/gc-integ), head 3680ece, NOT pushed.** Built on fix/gc-dr7a-cartassure
  (56a484b: cartassure.top + 17TRACK advisory, also unpushed). Push to main = prod deploy (Nathan's go).
  36 commits on 56a484b, 127 files. Gate on 3680ece: lint/format/typecheck/build 0; 280 files / 11,248 tests.
- **Everything new is DARK:** MENU_INJECTION_LIVE_ENABLED, MENU_LABEL_SIGNAL_ENABLED, STOREFRONT_GUARD_LIVE_ENABLED,
  STOREFRONT_GUARD_EMAIL_ENABLED all unset. Exceptions visible on deploy: (1) homepage check (RUNTIME_MALICIOUS... LIVE)
  now reads on*= handlers and `/`-separated attributes; (2) Sidekick instructions.md guardrails ship with
  `shopify app deploy`; (3) Settings scope card label "Menus and URL redirects"; (4) summary-email notice now stamps
  consent after render (client effect) instead of in the loader; (5) the 17TRACK advisory + cartassure.top from 56a484b.
- **Migrations (additive, auto-applied by railway.toml preDeployCommand):** 20261027100000_menu_injection_finding_type
  (enum ADD VALUE), 20261027200000_storefront_guard (2 tables + 2 nullable Shop cols), 20261027300000_guard_email_consent_hash.
- Audit history: lane audits (A 3 rounds, B 1), integration 3-way audit (0 HIGH/7 MED fixed), wave 2 deferred LOWs,
  final 3-way audit (0 HIGH/6 MED fixed), wave-3 audit (1 HIGH loader flood + 2 MED fixed), wave-4 audit (0 HIGH,
  1 MED fixed in wave 5). No open HIGH/MED.

### Before flags go on (owner)
- MENU_INJECTION: privacy policy check (we read menu labels); gc-7gjj.5 dev-store test (needs `! shopify store auth
  --store nw-dev-store-2.myshopify.com --scopes read_online_store_navigation,write_online_store_navigation,read_themes`):
  menus query cost + admin link /content/menus/{id} unverified.
- Checkout guard: gc-1q1s.1 slice 0 (dev-store /cart markup needs storefront password; prod read-failure mix needs
  Railway logs); Inngest headroom across 3 apps (tripwire STOREFRONT_GUARD_MONTHLY_STEP_ALERT default 20k).
- gc-7gjj.3 blocked on 2 weeks of MENU_LABEL_SIGNAL data.

### Decisions recorded (beads gc-1q1s, gc-7gjj.1)
Standard+Pro hourly + consented email, Free daily in-app only; consent = notice shown (stamped after render) or
Settings toggle, bound to a hash of the shown address; unsubscribe withdraws guard consent; incident open at consent
emailed within 24h of the later of open/consent; cart-only incident stays open if /cart becomes unreadable;
on<letters>= attributes always count; scope card relabelled; Dawn/Horizon fixtures OK under theme licence.

### Accepted LOWs (not fixed)
Attribute-breakout menu labels not flagged; 32-bit fingerprint collision; null consent hash covers generic owner
email wording; hostnames inside our sentences (validated); throttle doesn't count sent_not_recorded after a DB
failure; ledger prune has no (kind, sentAt) index (add if MerchantAlert grows).
