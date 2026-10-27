import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import type { NoticeClaimResponse } from "./notice-claim";

/** At most this many claim posts per page view: the first, and one retry. */
export const MAX_CLAIM_POSTS = 2;

/**
 * Render, then stamp (gc-1q1s.11): once a consent notice is on screen, post
 * its claim from an effect (effects run after the browser has the markup,
 * never during a server render). The server re-checks the gates and claims
 * atomically, so a repeat or a second tab is a no-op, and a page that never
 * mounts stamps nothing. Used by both of Home's consent notices (checkout
 * guard email, summary email) so the pattern stays one.
 *
 * A post that settles without an answer (a network error, no response) or
 * with the server's `retry` (its write failed) is retried ONCE (wave 3 U6).
 * An answer that the notice is not owed (claimed in another tab, not owed,
 * a different address) is final: no retry (wave 4).
 *
 * Settling is read from the submit's own promise (wave 4), never from
 * watching the fetcher pass through a busy state: a post that settles
 * between two renders is never lost. A response is told from the data that
 * was there before the post by identity (each response is a new object).
 */
export function useClaimRenderedNotice(notice: unknown, form: Record<string, string>): void {
  const fetcher = useFetcher<NoticeClaimResponse>();
  // attempts: posts sent; handled: settles already acted on; before: the
  // fetcher's data when the latest post went out.
  const claim = useRef<{ attempts: number; handled: number; before: unknown }>({
    attempts: 0,
    handled: 0,
    before: undefined,
  });
  // Bumped when a post settles, so the effect below runs after it.
  const [settled, setSettled] = useState(0);
  const shown = notice !== null && notice !== undefined;
  // A stable dependency for the form's values (a new object every render).
  const body = JSON.stringify(form);
  useEffect(() => {
    const c = claim.current;
    if (!shown) return;
    const post = () => {
      c.attempts += 1;
      c.before = fetcher.data;
      Promise.resolve(
        fetcher.submit(JSON.parse(body) as Record<string, string>, { method: "POST" }),
      )
        .catch(() => undefined)
        .finally(() => setSettled((n) => n + 1));
    };
    if (c.attempts === 0) {
      post();
      return;
    }
    // Nothing new settled (a re-render, or the post is still in flight).
    if (settled === c.handled) return;
    c.handled = settled;
    const data = fetcher.data;
    const answered = data !== undefined && data !== c.before;
    if (answered && !data.retry) return; // claimed, or final: not owed
    if (c.attempts >= MAX_CLAIM_POSTS) return;
    post();
    // `fetcher` is stable for the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, body, settled]);
}
