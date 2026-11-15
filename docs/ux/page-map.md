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

| | Free | Standard | Professional (trial) | Professional (paid) |
|---|---|---|---|---|
| Scan | 2 a month | 1 a week + monthly scheduled | 5 a day + weekly + on publish | same |
| See the problem | counts + up to 5 findings in full | everything (file, line, code) | everything | everything |
| Fix | do it yourself, only for the up to 5 shown | do it yourself (code editor + steps) | Clean copy, 5 removals total | Clean copy, unlimited |
| Security risks | full, never paywalled | same | same | same |

## Journey

| Stage | Merchant needs | Value action |
|---|---|---|
| Install → first scan | start fast | "Start first scan" (onboarding card, unchanged) |
| First result | what's wrong, what do I do | the plan's action card: remove for you / upgrade to remove |
| Remove | confirm and run | Clean copy select page: everything pre-selected, one tick, one button |
| After the copy | check, publish, confirm | Preview copy, publish in Themes; auto-rescan on publish confirms it's gone |
| Return visit | anything new? what has this done for me? | top of Home: what's new, the one action, value so far |

## Pages

### Home

- **Job:** "Is my store OK, and what's the one thing to do now?"
- **Header primary action:** **Scan now** (every plan). Limit used up: disabled with
  "Next scan <date>" and an upgrade link. Theme picker (Professional) and the usage line
  sit in one small row under the header, not in a card at the bottom.
- **Allowed above the action card:** security risk banners and checkout-guard incidents.
- **Action card (one, by plan and state):**
  - No scan yet: onboarding card, unchanged.
  - Professional paid, removable leftovers: "Remove N pieces of leftover code for you"
    + why line + **Make a clean copy** (goes straight to the select page).
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
- **Status line:** last scan date, what's new since the previous scan, value so far
  (e.g. "Removed 12 leftovers").
- **Notice slot:** at most one of: summary-email opt-in, feedback ask, multi-theme
  upsell, app-removed notice, new-high-findings notice (in that priority after security).
- **Supporting content (quieter):** "What it's costing you" (the one summary, decision
  1A); Theme health, trend, Most recent findings, Start here: cut or folded (no second
  summary of the same findings).

### Scan results

- **Job:** "What exactly did you find? Get rid of it."
- **Header primary action:** **Make a clean copy** (Professional, eligible); otherwise
  **Scan again**. Never "Back to History" (breadcrumb/back link instead).
- **Action card:** same card as Home for the plan and state.
- **Findings:** grouped by app (decision 3A). On a finding Clean copy can remove
  (Professional): **Remove with Clean copy** primary; manual steps in a "Do it yourself"
  disclosure. Standard: **Open in code editor** stays primary (that is its fix). Free:
  locked rows as today; the up to 5 shown keep their steps.
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
- **Value action:** the costliest app's row links to removing its leftovers (Clean copy
  filtered to that app; other plans: the upgrade card).

### History, Ignored, Settings, Help

Utilities. No value action; the header primary slot stays empty rather than "Back".

## Telemetry (to add)

| Event | Props |
|---|---|
| `action_card_shown` / `action_card_clicked` | plan, state, page |
| `header_scan_clicked` | plan, page |
| `upgrade_clicked` | plan, source (card, header) |
| `diy_opened` | plan, page |
| `clean_copy_select_viewed` / `clean_copy_run_started` / `clean_copy_run_finished` | counts removed / not removed |
| `clean_copy_preview_clicked` | |
| `return_after_clean_copy` | first return visit after a run |

IDs and counts only, on the existing event sink.

## Decision log

| Date | Decision |
|---|---|
| 2026-11-14 | 1A: one summary on Home, "What it's costing you". 2A: every plan sees the Clean copy card (upgrade on Free/Standard). 3A: findings grouped by app. 4B (Nathan): Standard leads with do it yourself; "Upgrade to Professional to remove them for you" is the second action. Finding cards show "Included in your clean copy" (no per-card button); scan header keeps Make a clean copy. |
