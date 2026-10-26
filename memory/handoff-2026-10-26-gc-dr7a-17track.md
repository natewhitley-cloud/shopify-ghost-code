## Session Handoff: 2026-10-26, gc-dr7a (cartassure.top + 17TRACK advisory) + spikes gc-7gjj / gc-1q1s

### RESUME HERE
- **Branch `fix/gc-dr7a-cartassure` (~/shopify/gc-dr7a), NOT pushed (Nathan: "don't push yet").** Push to main = prod deploy.
  Commits on 6f680a4: efccb39 + cc5827d (cartassure.top on the malicious list, audit LOWs), 85e89d5 + a52651a
  (17TRACK affected-app advisory, embed only, audit MED+LOW fixed). Gate on a52651a: lint/format/typecheck/build 0,
  259 files / 10,492 tests.
- Audits: blocklist 0 HIGH/0 MED (3 LOW fixed); advisory 0 HIGH, 1 MED (incidentDate) fixed, LOWs: stored summary
  fixed; ACCEPTED: headline surfaces (banner title, Start here, Theme health verdict, card) use shared copy "named in
  a security incident" without "unconfirmed" (only the banner body says unconfirmed); fixture header regex loosened.
- On deploy: APP_INCIDENT_ADVISORY_LIVE_ENABLED is already true in prod, so 17TRACK banners appear on the next scan
  of any shop with the 17track app embed enabled (all plans). Then close gc-dr7a.
- Known gap: homepage check does not read <img onerror>/on*= attributes (menu-label payload). Fix = gc-7gjj.4 (P1).

### Spikes (local branches, not pushed)
- gc-7gjj: ~/shopify/gc-7gjj spike/gc-7gjj e938907, docs/spikes/gc-7gjj-menu-label-injection-spike.md.
  Sub-beads gc-7gjj.1-.5 (.1 MENU_INJECTION P1, .4 on*= homepage P1, .5 needs Nathan OK for dev-store writes).
- gc-1q1s: ~/shopify/gc-1q1s spike/gc-1q1s 852283f, docs/spikes/gc-1q1s-checkout-guard-tier1-spike.md.
  Sub-beads gc-1q1s.1-.8. Decided 10-26: Standard + Pro hourly + email; Free daily in-app only; consent = one-time
  in-app notice (summaryNoticeShownAt pattern). Spike docs should be committed to main with the next docs push.
