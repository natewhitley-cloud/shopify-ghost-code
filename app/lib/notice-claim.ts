/**
 * The outcome of claiming a rendered consent notice (gc-1q1s.11, wave 4):
 *   - "claimed": this call stamped it;
 *   - "not_claimed": nothing to stamp (not owed, already stamped elsewhere,
 *     or a different address than the one shown); a retry cannot change it;
 *   - "failed": the write failed; a retry may succeed.
 */
export type NoticeClaim = "claimed" | "not_claimed" | "failed";

/** What Home's action answers a claim post: `retry` only after a failed write. */
export type NoticeClaimResponse = { noticeClaimed: boolean; retry?: true };

export function noticeClaimResponse(claim: NoticeClaim): NoticeClaimResponse {
  return claim === "failed"
    ? { noticeClaimed: false, retry: true }
    : { noticeClaimed: claim === "claimed" };
}
