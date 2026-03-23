## Session Handoff: 2026-03-22 — Legal Agent, Legal Doc Hardening, Prettier Hook, LLC Research

### What Got Done

- **Legal agent created** — Portfolio-level agent at `shopify/.claude/agents/legal.md` for writing, reviewing, and updating ToS/Privacy/DPA across all apps. Built from research across 10 Shopify apps (Judge.me, Loox, PageFly, Klaviyo, ReCharge, Vitals, UpPromote, Hextom, TinyIMG, Matrixify) and Shopify's official partner legal requirements. Includes Must Have / Should Have / Nice to Have review checklist, general risk assessment framework, and section templates for new apps.
- **Legal docs hardened** — Ran full legal review against Ghost Code's ToS and Privacy Policy. Fixed 10 findings:
  - **Privacy Policy**: Added Permission Audit feature disclosure (`read_apps` scope, installed app data, opt-in consent), expanded session PII fields (userId, locale, accountOwner, collaborator, emailVerified, tokens)
  - **Terms of Service**: Added Permission Audit to service description, added indemnification clause, force majeure, dispute resolution (informal → AAA arbitration → small claims exception), class action waiver, general provisions (severability, entire agreement, assignment, waiver, Shopify relationship/not liable clause)
  - Updated surviving sections reference to include new sections
  - ToS now 15 sections (was 12)
- **Jurisdiction updated** — Governing law changed from Texas/Travis County to Colorado/Boulder County across ToS
- **Prettier pre-commit hook** — Installed husky + lint-staged. Pre-commit runs prettier on staged `.ts`/`.tsx` files. Fixed Docker build failure (`prepare: "husky || true"` for `--omit=dev` compatibility). GC-8la closed.
- **Permission Audit epic closed** — GC-zse had all 20 subtasks done; epic marked closed.
- **CI lint fixes** — Removed unused React import, fixed import ordering in test files.
- **LLC research** — Compared formation services. Decision: Northwest Registered Agent for privacy (their address on all public filings). Saved post-formation checklist to memory.
- **CLAUDE.md updated** — Added Portfolio Agents section and Legal Docs section to portfolio-level CLAUDE.md.
- **Test count**: 657 (39 test files) — unchanged this session
- **Beads**: 67 total, 60 closed, 7 open. Net: GC-zse closed, GC-8la closed, GC-ue5 created.

### Key Decisions

- **Legal agent scope** — Covers both public-facing legal docs (priority 1) and Shopify-specific compliance (priority 2). Lives at portfolio level (`shopify/.claude/agents/legal.md`), not inside any single app.
- **Shopify requirements as foundation** — Official Shopify requirements form the non-negotiable baseline; app examples provide context for how others interpret/extend those requirements.
- **Northwest Registered Agent for LLC** — Privacy-focused (their address on all public filings, ~$39/yr). Rejected: LegalZoom (more expensive, $249/yr registered agent, upselly), DIY (home address public), Stripe Atlas (overkill for CO LLC), ZenBusiness (privacy is add-on not default).
- **Dispute resolution pattern** — Informal first (30 days) → AAA arbitration (Boulder County) → small claims exception + class action waiver. Protects solo operator from expensive litigation. Modeled after ReCharge's approach.
- **`husky || true` for Docker** — `prepare` script fails in `npm ci --omit=dev` because husky is a devDependency. `|| true` is the standard pattern to skip gracefully in production.

### Patterns & Discoveries

- **Shopify provides no legal templates** — No template Privacy Policy or ToS for app developers. Only a merchant-facing generator and a content outline. App developers must write their own.
- **DPA is a differentiator** — Only 6 of 10 researched apps have one. Having a DPA signals compliance maturity to growth-stage merchants.
- **"Shopify not liable" clause is required** — API Terms explicitly require merchant agreements to state developer sole responsibility and Shopify not liable. Most small apps miss this.
- **AI/ML disclosure is emerging** — Klaviyo has detailed AI terms, Matrixify discloses AI in support tickets. Worth including even as a negative statement ("we do not use AI").
- **Legal doc completeness correlates with company size** — Solo dev: PP + ToS minimum. Growing: add DPA. Enterprise: full legal hub (Klaviyo has 13+ docs).

### Uncommitted Changes

- `memory/` session files — not code, local only

### Open Backlog (7 beads)

- **GC-ue5** (P1): Form legal entity (LLC) — user doing this week via Northwest Registered Agent. Once done, update legal docs with entity name.
- **GC-mfj** (P1 epic): Deploy Ghost Code — 1 subtask remains (E2E test)
- **GC-ehc** (P2): Set up support email — blocks legal pages and app listing. Placeholder `support@ghostcode.app` doesn't exist yet.
- **GC-mfj.8** (P2): E2E test in dev store — checklist in `docs/e2e-test-checklist.md`. Free plan scan limit (1/1) needs reset first.
- **GC-qys** (P2): Better deploy error messages
- **GC-kis** (P3): Health score trend chart
- **GC-ngh** (P3): Prisma 6→7 upgrade

### Open Questions

- **Support email (GC-ehc)**: Depends on LLC formation — may want email under business domain. Options: (A) Custom domain email (ghostcode.app — requires domain purchase + email hosting), (B) Gmail (free, less professional), (C) Business domain email via Google Workspace (~$6/mo). Decision criteria: LLC name, domain availability, cost. Resolve after LLC is formed.

### Recommended Next Steps

1. **Form LLC** via Northwest Registered Agent — unblocks GC-ue5 and downstream doc updates
2. **Set up support email** (GC-ehc) — once LLC/domain is decided
3. **Update legal docs with entity name** — close GC-ue5
4. **E2E test in dev store** (GC-mfj.8) — reset scan limit, walk through checklist
5. **Add legal URLs to Partner Dashboard** — Privacy Policy + ToS URLs in app listing
6. **Submit for app review** — after all above

### Risks & Warnings

- **Railway auto-deploys from main** — every push deploys. No staging. CI lint fix from this session is now live.
- **Free plan scan limit** — Dev store has 1/1 used. Can't test scanning without reset.
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet.
- **2 structural lint warnings remain** — import ordering in test files where `vi.mock()` must precede mocked imports. These are false positives and won't cause CI failure (warnings only, not errors).

### CI State

- All green after lint fix push: lint ✓, format ✓, typecheck ✓, tests ✓ (657 passing)
- Pre-commit hook active (husky + lint-staged)

### Inngest State

- Inngest Cloud active, 4 functions synced
- No changes this session
