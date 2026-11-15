# GhostCode: UX page map

Rule: `~/.claude/rules/merchant-ux.md` (each page: at most 1-2 value actions, easy to
find, obviously the thing to do and why, easy to use; mapped per plan). Update this file
in the same change as any UI change. Written 2026-11-14 after Nathan found Clean copy
and the Scan button effectively hidden ("where's Waldo").

## Job to be done

"When apps I've removed (or still run) may be slowing, breaking or exposing my store,
I want to know what's there and get rid of it safely, without paying a developer or
breaking my theme."

## Value actions (whole app)

1. **Scan** (find out). Diagnosis only.
2. **Remove leftover code** (Clean copy). The payoff. Professional only; other plans
   see it as the upgrade, with their own numbers.
3. **Make it safe** (security risk). Only when one exists. Never paywalled.

History, Ignored, Settings and Help are utilities with no value action.

## What each plan allows

|                 | Free                                       | Standard                             | Professional (trial)          | Professional (paid)   |
| --------------- | ------------------------------------------ | ------------------------------------ | ----------------------------- | --------------------- |
| Scan            | 2 a month                                  | 1 a week + monthly scheduled         | 5 a day + weekly + on publish | same                  |
| See the problem | counts + up to 5 findings in full          | everything (file, line, code)        | everything                    | everything            |
| Fix             | do it yourself, only for the up to 5 shown | do it yourself (code editor + steps) | Clean copy, 5 removals total  | Clean copy, unlimited |
| Security risks  | full, never paywalled                      | same                                 | same                          | same                  |

## Journey

| Stage                | Merchant needs                           | Value action                                                               |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| Install → first scan | start fast                               | "Start first scan" (onboarding card, unchanged)                            |
| First result         | what's wrong, what do I do               | the plan's action card: remove for you / upgrade to remove                 |
| Remove               | confirm and run                          | Clean copy select page: everything pre-selected, one tick, one button      |
| After the copy       | check, publish, confirm                  | Preview copy, publish in Themes; auto-rescan on publish confirms it's gone |
| Return visit         | anything new? what has this done for me? | top of Home: what's new, the one action, value so far                      |

## Pages

### Home

- **Job:** "Is my store OK, and what's the one thing to do now?"
- **Header primary action:** **Scan now** (every plan). Limit used up: disabled with
  "Next scan <date>" and an upgrade link. Theme picker (Professional) and the usage line
  sit in one small row under the header, not in a card at the bottom.
- **Allowed above the action card:** security risk banners and checkout-guard incidents.
  Backup (gc-np1d.6): when the latest scan found known malicious code and no security
  banner names it (e.g. its read failed), a critical "Your last scan found known
  malicious code" banner links to the scan, on every plan.
- **Action card (one, by plan and state):**
  - No scan yet: onboarding card, unchanged.
  - Professional paid, removable leftovers: "Remove N pieces of leftover code for you"
    - why line + **Make a clean copy** (goes straight to the select page).
  - Professional trial: "Remove up to R now. The other N-R unlock on <date>." +
    **Make a clean copy**.
  - Professional, scan too old for Clean copy: "Scan again to remove these" + **Scan now**.
  - Standard (decision 4B): "Fix N pieces of leftover code" + **See how to fix them**
    (jumps to the findings list, each with Open in code editor); under it, secondary:
    "Upgrade to Professional to remove them for you".
  - Free: "We found N leftovers from A apps. Remove them for you on Professional" +
    **Upgrade**; "Compare plans" link.
  - Nothing found: "All clear" + the reason to scan again (theme changed, last scan
    X days ago). The rescan and theme-changed nudges live here, not as banners.
  - "Leftovers" = findings with a consequence lane (what "What it's costing you"
    counts). Security findings (malicious code, app advisories, code in a menu) are
    never leftovers and never sold as an upgrade (audit 2026-11-14).
  - No card: security findings but no leftovers (the security banner owns the page;
    "All clear" never shows beside it, even for ignored malicious code), and Free
    when nothing found is removable or Clean copy is off. With no card, the rescan
    and theme-changed banners show as before.
  - Some leftovers removable, some not: upgrade copy says "removes N of them".
- **Status line:** last scan date, what's new since the previous scan, value so far
  (e.g. "Removed 12 leftovers").
- **Notice slot (built gc-np1d.6, `pickHomeNotice`):** at most one, at the bottom of
  the page below "What it's costing you", in this priority: checkout guard email
  notice, "summary emails are on" notice, summary-email opt-in (its success or failure
  line keeps the slot after "Turn on"), feedback ask, multi-theme upsell, app-removed
  notice, new-high-findings notice. The two consent notices were not in the spec's
  list; they rank first because they record consent. Dismissing or answering the
  winner hands the slot to the next. Each keeps its existing copy, actions and
  dismiss intent, as a Polaris banner whose buttons are all tertiary: the slot is
  quiet, so Home's only primary actions stay the header Scan now and the action card. Only the winner records a "shown" stamp:
  while a consent notice is offered, or was claimed in the last 24h (it may still be
  on screen), the loader resolves no opt-in or feedback prompt at all.
  Outside the slot: the scan-start error, security and checkout-guard banners, the
  scan-limit copy, the rescan and theme-changed nudges, the install-source card.
- **Supporting content (quieter):** "What it's costing you" (the one summary, decision
  1A); its Start here chip follows the lane ranking. Its "You're all clear" state
  shows only when there is no action card; when the card says "All clear", the
  lanes card is left out (one all-clear on the page). Removed from Home in gc-np1d.6
  (no second summary of the same findings): the findings count tile and its change
  since the last scan, "Most recent findings", the Start here findings block, the
  Theme health checklist and the findings trend chart (and its empty state).

### Scan results

- **Job:** "What exactly did you find? Get rid of it."
- **Header primary action:** **Make a clean copy** (Professional, eligible); otherwise
  **Scan again**. Never "Back to History" (breadcrumb/back link instead).
- **Action card:** same card as Home for the plan and state.
- **Findings:** grouped by app (decision 3A), in the paid list and the Free preview: one
  card per app, headed by the app name and "N findings" (the app's total under the
  active filters, across every page; Free adds "· K shown"). No install status: the scan
  data does not say an app was uninstalled. Apps by worst severity, then count, then
  name; findings with no app last, under "Other code"; severity then filename inside a
  group. Pages follow the same order, so a group cut by a page boundary continues on
  the next page under the same header. On a finding Clean copy can remove
  (Professional): an "Included in your clean copy" label, with the manual steps in a
  "Do it yourself" disclosure; no per-card button (the header and the action card hold
  Make a clean copy). Standard: **Open in code editor** stays primary (that is its fix).
  Free: locked rows as today; the up to 5 shown keep their steps.
- **Notice slot (decision A, 2026-11-15):** at most one, directly below the action card:
  upgrade-return banner, else the UpgradePreview teaser (Free; Standard has no teaser
  on this page), else the stale results notice. Quiet: tertiary buttons only. Only the
  notice shown records its "shown" stamp. The action card is the one upgrade ask above
  the findings and the slot may hold one more; nothing else on the page asks for an
  upgrade (the truncated-walk notice keeps its "Professional checks ..." line with no
  button). With hidden findings on Free the teaser or return banner always holds the
  slot, so the stale notice shows there only when nothing is hidden. When it loses the
  slot, the status bar says "Your theme changed on {date}, so some findings may already
  be fixed." as plain text (no button, no link, no "shown" stamp).
- **Supporting:** filters, exports, App Impact Map, unrecognized scripts.

### Clean copy: select

- **Job:** "Confirm what gets removed, then start."
- **Value action:** one button. Everything removable pre-selected; one consent tick;
  about two clicks from landing to the run starting.

### Clean copy: result

- **Job:** "Check the copy and publish it."
- **Header primary action:** **Preview copy**. Then: publish in Themes; then we confirm
  it's gone (auto-rescan on publish).

### Store speed

- **Job:** "Is my store slow, and what's slowing it?"
- **Value action:** the costliest app's row links to its leftovers ("See its N leftovers"):
  the scan page of the live theme's latest successful scan, filtered to that app
  (`/app/scans/<id>?app=<name>`), where the plan's own action card leads (Clean copy on
  Professional, the upgrade elsewhere). Only the costliest app of each page section (and the
  free test's one app line) links; a plain link on every plan, never a primary button. A row
  links only on an exact app name match (trim + lower-case) with leftover code above 0, ignored
  findings and security findings left out; an app still installed has none, so it has no link.

### History, Ignored, Settings, Help

Utilities. No value action; the header primary slot stays empty rather than "Back".

## Telemetry (to add)

| Event                                                                             | Props                          |
| --------------------------------------------------------------------------------- | ------------------------------ |
| `action_card_shown` / `action_card_clicked`                                       | plan, state, page              |
| `header_scan_clicked`                                                             | plan, page                     |
| `upgrade_clicked`                                                                 | plan, source (card, header)    |
| `diy_opened`                                                                      | plan, page                     |
| `clean_copy_select_viewed` / `clean_copy_run_started` / `clean_copy_run_finished` | counts removed / not removed   |
| `clean_copy_preview_clicked`                                                      |                                |
| `return_after_clean_copy`                                                         | first return visit after a run |

IDs and counts only, on the existing event sink.

## Decision log

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-14 | 1A: one summary on Home, "What it's costing you". 2A: every plan sees the Clean copy card (upgrade on Free/Standard). 3A: findings grouped by app. 4B (Nathan): Standard leads with do it yourself; "Upgrade to Professional to remove them for you" is the second action. Finding cards show "Included in your clean copy" (no per-card button); scan header keeps Make a clean copy. |
| 2026-11-15 | A (Nathan, audit r1 M6): the Free scan page showed up to 3 upgrade asks. The UpgradePreview teaser and the upgrade-return banner fold into the scan page's one notice slot (slice 2); slice 1 ships as is.                                                                                                                                                                             |
