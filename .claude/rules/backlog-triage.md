---
strength: must
---

# Backlog Triage from Review/Audit Docs

When filing beads from a review doc, audit, or any batch of findings, verify
each finding against the **current code and full git history** — not just the
doc, the handoff, and the list of closed beads.

## Why This Rule Exists

Session 9 filed 41 beads off `review-2026-06-12.md`, cross-referencing only
*closed beads* to detect already-done work. That missed fixes landed via direct
PRs (#3–#7) that were never beaded — LOG-5/6/7/8/10 had all been fixed in
unbeaded commits. Result: 5 duplicate beads describing work that was already
shipped. Session 8 flagged the same lesson for *dispatch*; it wasn't applied to
*filing*. Twice-bitten, so it's now a rule.

The trap: closed beads are an **incomplete** record of what's done. Direct-PR
fixes, hotfixes, and refactors that touched the finding's code leave no bead
behind. Git history is the source of truth, not the bead graph.

## Do This

- For each finding, read the **current** code at the cited location before
  filing. If the issue is already fixed, don't file — note it as resolved.
- Check `git log` (and `git log -- <path>` / `git log -S '<symbol>'`) for prior
  work touching the finding's code, including unbeaded direct-PR commits.
- When a finding is partially addressed, file the **remainder only** and write a
  scope-reduction note in the bead body stating what's already done.
- Cross-reference closed beads *and* commit history — treat them as two separate
  sources that must agree.

## Don't Do This

- Don't treat the closed-bead list as a complete record of shipped work.
- Don't file a bead straight from a review doc's description without opening the
  cited file first.
- Don't re-file the already-done half of a partially-fixed finding.

## Related

- Mirrors `definition-of-done.md`'s "verify end-to-end" discipline and the
  existing practice of reading `docs/pricing-and-plans.md` before plan-gating
  changes — confirm against reality before acting on a secondhand description.
