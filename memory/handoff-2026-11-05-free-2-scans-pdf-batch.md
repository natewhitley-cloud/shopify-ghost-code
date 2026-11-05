## Session Handoff: 2026-11-05, Free 2 scans + Standard PDF + gc-2x0o + gc-08x8 item 3 (NOT pushed)

### RESUME HERE
- **Branch `feat/gc-258i-free-2-scans`** (worktree ~/shopify/gc-258i), on origin/main 9c75db8. NOT pushed; push to main = prod deploy (Nathan's go).
- Gate on e0708f4: lint 0, format:check 0, tsc 0, build 0; 292 files / 11,569 passed + 1 expected fail.
- Commits: eeffc63 gc-258i + gc-pqg0, 541e49d gc-2x0o, 8c6ac12 gc-08x8 item 3 fixture tests (from fork branch spike/gc-08x8-new-arch f885da5), 957d688 doc severity (reverted in e0708f4), e0708f4 audit round 1.
- Audit round 1: 0 HIGH; 2 MEDIUM fixed (F1 doc regex reverted, F2 pricing doc owner-action notes), 6 LOW fixed, F9 -> gc-ydze, F11 -> gc-0uht, F6 open for Nathan.

### What shipped on the branch
- gc-258i: Free = 2 manual scans a month; first scan ever still bypasses the quota and counts as one. Bullet "2 manual scans a month".
- gc-pqg0: PDF export on Standard (it already existed, Pro-only, gc-rrh.1). Locked "Export PDF (Pro)" removed. Standard bullet 7 "PDF report to share with your team".
- gc-2x0o: a live app's suppressed theme-file findings no longer read as Fixed. Rules shared in app/services/live-app-suppression.server.ts (theme-file + gc-k71c product types).
- gc-08x8 item 3: skeleton-theme rc-v2.0.0 @56730a9 scanned offline: 0 false positives, {% block %}/{% partial %} parse with correct lines, AGENTS.md ignored. Gap gc-15d9 ({% doc %}/{% comment %} opener outside the 3-line snippet stays HIGH).

### Owner (Nathan) before / at deploy
1. F6 wording: "First scan always free" + "2 manual scans a month" can read as 3. Options: keep; drop bullet 1; or "2 scans a month, first included".
2. Deploy day: Partner Dashboard Free bullet 2 -> "2 manual scans a month"; Standard add bullet 7 "PDF report to share with your team" (pricing-and-plans.md "Pending owner action" notes; remove them after).
3. gc-u6hg listing refresh: Free plan line + PDF mention (its premise "GhostCode has no export" was wrong).

### Still open
- gc-dg5e: needs a Canvas theme on a dev store (Nathan: "Duplicate in Canvas" in admin). `shopify store execute -s nw-dev-store-2.myshopify.com` works for reads (no Canvas theme there 11-05: Horizon, debut-vintage-theme, test-data MAIN).
- gc-08x8 live-only items: app block/embed representation in new architecture, AGENTS.md via API, items 1/2/4.
- gc-xdpi: not a cheap fix (new Speed page list + copy); deferred.
- gc-tib: exemption still not submitted; D1-D3/D5/D6/D8/D9 open.
