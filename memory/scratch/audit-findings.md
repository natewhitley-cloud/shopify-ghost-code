# ReadQuest Full Codebase Audit — Synthesized Findings

**Date:** 2026-03-11
**Scope:** Security, Logic/Correctness, Code Quality/Patterns
**Codebase:** /Users/nathanwhitley/book-quiz/ (165 books, 146 quizzes, 51 API routes, 26 migrations)

## Executive Summary

| Priority  | Count  | Key Themes                                                             |
| --------- | ------ | ---------------------------------------------------------------------- |
| P0        | 0      | None — no ship-blockers                                                |
| P1        | 4      | Race conditions, unsafe JSONB casts, API key timing                    |
| P2        | 16     | Error handling, state consistency, security headers, DRY, test quality |
| P3        | 8      | Documentation, pagination, idempotency, minor enhancements             |
| **Total** | **28** |                                                                        |

| Type          | Count |
| ------------- | ----- |
| security      | 10    |
| bug / logic   | 8     |
| best-practice | 7     |
| enhancement   | 3     |

**Overall assessment:** Strong security fundamentals (httpOnly cookies, HMAC signing, rate limiting, bcrypt). Main gaps are infrastructure-level (security headers, timing attacks) and error-handling consistency in the rewards pipeline. No critical data-loss bugs found.

---

## P1 — Must Fix (4 findings)

### [F-01] API Key Authentication Vulnerable to Timing Attacks

Priority: P1 | Type: security | Complexity: M

**Problem:** In `src/app/api/admin/books/bulk-add/route.ts:155` and ~13 other admin routes, API key comparison uses simple string equality (`authHeader === \`Bearer ${apiKey}\``), which is vulnerable to timing attacks. The codebase already uses `crypto.timingSafeEqual()`for challenge tokens in`src/lib/auth/challenge-token.ts:138`.

**Impact:** Attacker could infer API key value byte-by-byte via response time measurement.

**Recommended fix:** Use `crypto.timingSafeEqual()` with Buffer conversion for all API key comparisons. Extract to a shared `verifyApiKey()` utility and apply across all admin routes.

---

### [F-02] Concurrent Quiz Submission Can Double-Award Points

Priority: P1 | Type: bug | Complexity: M

**Problem:** In `src/lib/rewards/points.ts:45-59`, `awardPoints` relies on UNIQUE constraint (`23505` error code) for idempotency. But when two submissions race, both succeed at the quiz_attempts INSERT level. The loser gets 0 points but `processQuizRewards` still runs (since `isFirstPass` is based on prior progress state, not points actually awarded). Student sees celebration with 0 points but badges still awarded.

**Impact:** Concurrent submissions (double-click, network retry) cause inconsistent reward data — 0 points shown with new badges. Points ledger stays correct due to UNIQUE, but UX is confusing.

**Recommended fix:** Before calling `processQuizRewards`, check if `pointsAwarded === 0 && isFirstPass`. If so, return "duplicate submission" result, skip reward pipeline. Also remove unused student fetch at lines 65-69.

---

### [F-03] Unsafe JSONB Column Casts Without Runtime Validation

Priority: P1 | Type: best-practice | Complexity: M

**Problem:** JSONB columns cast to typed structures without validation:

- `src/app/api/quiz/[quizDefId]/submit/route.ts:230-231` — `quizDef.answer_key as AnswerKeyEntry[]`, `quizDef.questions as QuizQuestion[]`
- `src/lib/auth/image-pick.ts:122` — `student.favorites as StudentFavorites`

If DB contains malformed data (migration failure, manual edit), the cast silently produces incorrect types causing downstream crashes.

**Impact:** Silent type breakage at runtime. Hard to debug in production.

**Recommended fix:** Create a `safeCast<T>(data: unknown, schema: ZodSchema<T>): T` utility (~5 lines). Wraps cast with validation, throws with context on mismatch. Apply to all 5-7 JSONB cast sites.

---

### [F-04] Streak Update Throws Uncaught in Rewards Pipeline

Priority: P1 | Type: bug | Complexity: S

**Problem:** In `src/lib/rewards/streaks.ts:154-260`, database failures throw errors. But in `src/lib/rewards/index.ts:104-122`, `updateStreak` is not wrapped in try-catch. If it throws, `processQuizRewards` terminates without returning a result. The quiz attempt is already saved (line 404 in submit route), leaving partial state — attempt recorded but no streak/badge updates.

**Impact:** Student sees no reward feedback. Streak and badge data permanently lost for that quiz pass.

**Recommended fix:** Wrap `updateStreak` in try-catch in `src/lib/rewards/index.ts`. Log error, continue with defaults (`current_streak_weeks=0, streak_advanced=false`). Return partial result to client.

---

## P2 — Should Fix (16 findings)

### [F-05] Rate Limiter State Lost on Cold Starts

Priority: P2 | Type: security | Complexity: S

**Problem:** `src/lib/auth/rate-limiter.ts` uses in-memory Map with TTL cleanup. State resets on Vercel cold starts/redeployments (documented in code comments lines 14-16). With 4-digit PINs (~10K possibilities) and 5 attempts per lockout, coordinated attacks across cold starts could brute-force accounts.

**Impact:** Attacker monitoring deployments could bypass rate limiting during cold-start windows.

**Recommended fix:** Increase MAX_FAILURES and LOCKOUT_DURATION_MS as immediate mitigation. Long-term: migrate to durable backend (Supabase table or Redis).

---

### [F-06] Missing Security Headers

Priority: P2 | Type: security | Complexity: S

**Problem:** `next.config.js` has no security header configuration. No middleware adding CSP, X-Frame-Options, HSTS, X-Content-Type-Options.

**Impact:** Missing CSP allows injected scripts; missing X-Frame-Options allows clickjacking; missing HSTS weakens TLS enforcement.

**Recommended fix:** Create `src/middleware.ts` with Next.js middleware injecting standard security headers (HSTS, CSP, X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy).

---

### [F-07] IP Address Spoofing Not Mitigated in Rate Limiter

Priority: P2 | Type: security | Complexity: M

**Problem:** `src/lib/auth/client-ip.ts` reads `x-forwarded-for` without validation. Safe on Vercel (trusted proxy), but vulnerable if deployed elsewhere.

**Impact:** Attacker can spoof IP to bypass per-IP rate limiting on PIN brute-force.

**Recommended fix:** Document Vercel dependency. Add config flag for trusted proxy validation. Consider secondary rate limiting (user-agent, fingerprint).

---

### [F-08] Admin API Key Actions Not Audit Logged

Priority: P2 | Type: security | Complexity: S

**Problem:** In `src/app/api/admin/books/bulk-add/route.ts:270`, audit logs only write when `actorId` is present (session-based auth). API key invocations skip audit logging entirely.

**Impact:** Compromised API key operations leave no trace. Audit trail gap for CLI/cron operations.

**Recommended fix:** Always log API key invocations with fixed actorId like `api_key_automated`. Include key fingerprint (last 4 chars) for tracking.

---

### [F-09] Session Soft-Delete Check Not Atomic

Priority: P2 | Type: security | Complexity: M

**Problem:** In `src/lib/auth/session.ts:134-152`, session validation and soft-delete check are separate queries. Race window: session validates, then parent deletes student, then request proceeds with stale session.

**Impact:** Deleted student can briefly access resources during the race window.

**Recommended fix:** Combine into single query with JOIN filter: `.and('student_accounts!inner.deleted_at.is.null')`.

---

### [F-10] Cookie Domain Not Explicitly Set

Priority: P2 | Type: security | Complexity: S

**Problem:** `src/lib/auth/session.ts:78-84` sets session cookie without `domain` attribute.

**Impact:** Low currently. Risk if domain changes or wildcard subdomain introduced later.

**Recommended fix:** Add comment documenting intentional default scoping. Consider explicit `domain: undefined` to prevent future accidents.

---

### [F-11] Progress State Machine: Lockout Expiry Doesn't Update Row

Priority: P2 | Type: bug | Complexity: S

**Problem:** In `src/app/api/quiz/[quizDefId]/submit/route.ts:265-278`, when lockout expires, code treats it as `retake_available` but never updates the DB row. `student_book_progress` still shows `status='locked_out'` with expired timestamp.

**Impact:** Stale zombie state. Analytics queries filtering on `status='locked_out'` count incorrectly. Row represents a lie about current state.

**Recommended fix:** After line 277, UPDATE progress row to `status='retake_available'` and `lockout_until=null`.

---

### [F-12] Badge Evaluation Runs Before Progress Update Commits

Priority: P2 | Type: bug | Complexity: M

**Problem:** In quiz submit flow: (1) attempt inserted, (2) progress updated (may fail), (3) `processQuizRewards` called. Badge evaluation in `badges.ts:149-161` queries `student_book_progress` — but if step 2 failed, badges calculate from stale data.

**Impact:** If progress update fails, badges are awarded based on wrong data. Student may earn/miss badges incorrectly.

**Recommended fix:** Check `progressError2` before calling `processQuizRewards`. If progress failed, skip rewards and return error state.

---

### [F-13] GLE Recalculation Returns Stale Result on Persistence Failure

Priority: P2 | Type: bug | Complexity: S

**Problem:** In `src/lib/rewards/gle-recalculation.ts:154-160`, DB update failure is logged but function still returns the new GLE value. Client shows updated reading level that was never persisted.

**Impact:** Student sees reading level update in celebration, but on refresh it reverts. Parent dashboard shows stale data.

**Recommended fix:** Return `{ new_reading_level: null }` when persistence fails so client doesn't show phantom update.

---

### [F-14] Quiz Definition Race Condition (Operationally Noisy)

Priority: P2 | Type: bug | Complexity: M

**Problem:** In `src/app/api/quiz/generate/route.ts:124-147`, concurrent requests for same book race on quiz_definition insert. Recovery (re-query) works correctly, but logs spurious errors that obscure real failures.

**Impact:** Log noise from expected race conditions masks genuine errors.

**Recommended fix:** Use `INSERT ... ON CONFLICT DO UPDATE` for atomic upsert. Or change recovery path to log at WARN level with "concurrent insert" context.

---

### [F-15] Search Enrichment Partial Failure Shows Wrong Flags

Priority: P2 | Type: bug | Complexity: M

**Problem:** In `src/app/api/books/search/route.ts:104-139`, student enrichment queries (progress, quiz status) run in parallel. If one fails, it falls back to empty sets — showing `student_passed: false` for passed books.

**Impact:** Transient DB errors cause incorrect UI flags (book appears "not passed" when it was).

**Recommended fix:** Log enrichment failures with student context. Consider showing "unknown" state instead of false when enrichment fails.

---

### [F-16] Bulk Import GLE Estimation Failures Silent to Admin

Priority: P2 | Type: bug | Complexity: S

**Problem:** In `src/app/api/admin/books/bulk-add/route.ts:311-317`, GLE estimation via `after()` callbacks runs after response is sent. Failures logged but admin never sees them.

**Impact:** Admin expects books to be enriched and quiz-ready, but some silently remain in 'raw' status.

**Recommended fix:** Provide admin endpoint to check pending/failed GLE jobs. Or schedule estimation before response (slower but more reliable).

---

### [F-17] Inconsistent Supabase Error Handling Across Routes

Priority: P2 | Type: best-practice | Complexity: M

**Problem:** Error handling varies across routes:

- Some check `error.message` (may be undefined → silent null access)
- Some differentiate error codes (PGRST116)
- Some use `Promise.all` without handling individual rejections

**Impact:** Inconsistent error responses; some routes leak internal messages; Promise rejections crash unhandled.

**Recommended fix:** Create `SafeSupabaseQuery` wrapper utility that normalizes error checking, logging, and response shape.

---

### [F-18] API Tests Missing Response Body Assertions

Priority: P2 | Type: best-practice | Complexity: S

**Problem:** Several API tests (e.g., `tests/unit/api-quiz-submit.test.ts:273`) verify HTTP 200 but don't assert response body structure. Route could return `{ error: "..." }` at 200 and tests pass.

**Impact:** Response shape regressions go unnoticed. Client code crashes in production.

**Recommended fix:** Add `expect(body).toHaveProperty(...)` checks to existing tests. Start with highest-traffic routes: quiz submit, student progress, auth login.

---

### [F-19] Validation Schema Duplication Across Auth Routes

Priority: P2 | Type: best-practice | Complexity: M

**Problem:** Email validation schema repeated 3+ times across login, registration, step1 routes. PIN validation also duplicated. Changes require 3+ edits.

**Impact:** Schema drift risk; inconsistent validation across auth flows.

**Recommended fix:** Extract to `src/lib/auth/schemas.ts` with shared Zod schemas (email, PIN, password).

---

### [F-20] Response Format Inconsistency Across Routes

Priority: P2 | Type: best-practice | Complexity: S

**Problem:** Some routes return `{ success: true, data: ... }`, others return bare data. No consistent envelope.

**Impact:** Client code needs route-specific parsers; harder to build generic error handling.

**Recommended fix:** Establish standard `{ success: boolean, data?: T, error?: string }` envelope. Enforce for new routes; incrementally migrate existing.

---

## P3 — Nice to Have (8 findings)

### [F-21] Partial Quiz Submission Scoring Without Server Validation

Priority: P3 | Type: enhancement | Complexity: S

**Problem:** `src/app/api/quiz/[quizDefId]/submit/route.ts` scores based on `answers.length` (submitted count), not questions assigned. Student submitting 5 of 10 questions is scored out of 5, potentially getting 100%.

**Impact:** Low risk with trusted web client. Would be exploitable with untrusted clients.

**Recommended fix:** Store question count server-side during quiz generation; validate submitted count matches.

---

### [F-22] Login Timing Leak Reveals Email Existence

Priority: P3 | Type: security | Complexity: S

**Problem:** `src/app/api/auth/parent/login/route.ts:70-72` — missing email returns fast, wrong password goes through bcrypt (~100ms). Timing difference reveals whether email exists.

**Impact:** Email enumeration via timing analysis.

**Recommended fix:** Add dummy `bcrypt.compare()` call when email not found to equalize timing.

---

### [F-23] Challenge Token Expiry Has No Jitter

Priority: P3 | Type: security | Complexity: S

**Problem:** `src/lib/auth/challenge-token.ts:21` — fixed 5-minute expiry with no randomization.

**Impact:** Very low — mainly theoretical. Predictable expiry window.

**Recommended fix:** Add ±10-20 second random jitter to TOKEN_EXPIRY_MS.

---

### [F-24] No Session Fixation Protection Beyond UUID Randomness

Priority: P3 | Type: security | Complexity: M

**Problem:** Session IDs not rotated on privilege changes (parent↔student switch). Old sessions deleted from DB but ID not rotated per-request.

**Impact:** Very low — UUIDs are unpredictable. Acceptable for MVP.

**Recommended fix:** Document as accepted risk. Consider session rotation on privilege change if threat model escalates.

---

### [F-25] GLE Docstring Says "LIMIT 5" But Code Uses WINDOW_SIZE=10

Priority: P3 | Type: bug | Complexity: S

**Problem:** `src/lib/rewards/gle-recalculation.ts:40` — comment says "LIMIT 5" but actual constant is 10 (line 22).

**Impact:** Developer confusion during maintenance.

**Recommended fix:** Update comment to reference WINDOW_SIZE constant.

---

### [F-26] Error Response Boilerplate Repeated Across Routes

Priority: P3 | Type: best-practice | Complexity: S

**Problem:** Zod validation error handling pattern (safeParse → map issues → NextResponse 400) repeated in 10+ routes with minor inconsistencies.

**Recommended fix:** Create `parseRequest(body, schema)` utility returning `{ ok, data } | { ok: false, response }`.

---

### [F-27] Missing Idempotency Headers on Non-Idempotent Routes

Priority: P3 | Type: best-practice | Complexity: M

**Problem:** POST routes (quiz submit, login, registration) don't support Idempotency-Key headers. Client retries can create duplicates.

**Impact:** Duplicate quiz attempts on network retries. DB constraints prevent worst outcomes.

**Recommended fix:** Document retry behavior. Long-term: implement `Idempotency-Key` header support with cached responses.

---

### [F-28] Promise.all in Progress Route Fails All-or-Nothing

Priority: P3 | Type: enhancement | Complexity: S

**Problem:** `src/app/api/student/progress/route.ts` uses `Promise.all()` — if any query rejects, entire GET returns 500 with no partial data.

**Impact:** Single query timeout kills entire progress page.

**Recommended fix:** Swap to `Promise.allSettled()` and handle partial results gracefully.

---

## Suggested Sprint Groupings

### Sprint A: "Rewards Pipeline Hardening" (P1 focus)

- F-02: Concurrent submission double-award
- F-04: Streak uncaught throw
- F-12: Badge eval before progress commits
- F-13: GLE stale result on failure
- F-11: Lockout expiry state fix

### Sprint B: "Security Headers & Auth Tightening"

- F-01: API key timing attack
- F-06: Security headers middleware
- F-05: Rate limiter durability
- F-08: Admin API key audit logging

### Sprint C: "API Quality & Consistency"

- F-03: safeCast utility for JSONB
- F-17: Supabase error handling utility
- F-19: Shared auth schemas
- F-18: Test response body assertions

### Sprint D: "Polish & Robustness"

- F-14, F-15, F-16, F-20 (remaining P2s)
- F-21 through F-28 (P3s as time allows)
