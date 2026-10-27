import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";

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
 * A post that settles without a successful claim (a network error, or the
 * server's `noticeClaimed: false` after a failed write) is retried ONCE
 * (wave 3 U6): a lost post used to leave a merchant who saw the notice
 * without consent for the rest of the page view. The server's atomic claim
 * keeps it to at most one successful claim however many posts land.
 */
export function useClaimRenderedNotice(notice: unknown, form: Record<string, string>): void {
  const fetcher = useFetcher<{ noticeClaimed?: boolean }>();
  // attempts: posts sent; inFlight: a post not yet settled; sawBusy: that
  // post has been seen in flight (so an idle fetcher means it settled).
  const claim = useRef({ attempts: 0, inFlight: false, sawBusy: false });
  const shown = notice !== null && notice !== undefined;
  // A stable dependency for the form's values (a new object every render).
  const body = JSON.stringify(form);
  const busy = fetcher.state !== "idle";
  const claimed = fetcher.data?.noticeClaimed === true;
  useEffect(() => {
    const c = claim.current;
    if (!shown) return;
    if (c.inFlight) {
      if (busy) {
        c.sawBusy = true;
        return;
      }
      if (!c.sawBusy) return; // submitted, not started yet
      c.inFlight = false;
      if (claimed || c.attempts >= MAX_CLAIM_POSTS) return;
    } else if (c.attempts > 0) {
      return;
    }
    c.attempts += 1;
    c.inFlight = true;
    c.sawBusy = false;
    fetcher.submit(JSON.parse(body) as Record<string, string>, { method: "POST" });
    // `fetcher` is stable for the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, body, busy, claimed]);
}
