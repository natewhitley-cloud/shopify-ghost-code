import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";

/**
 * Render, then stamp (gc-1q1s.11): once a consent notice is on screen, post
 * its claim ONCE per page view from an effect (effects run after the browser
 * has the markup, never during a server render). The server re-checks the
 * gates and claims atomically, so a repeat or a second tab is a no-op, and a
 * page that never mounts stamps nothing. Used by both of Home's consent
 * notices (checkout guard email, summary email) so the pattern stays one.
 */
export function useClaimRenderedNotice(notice: unknown, form: Record<string, string>): void {
  const fetcher = useFetcher();
  const posted = useRef(false);
  const shown = notice !== null && notice !== undefined;
  // A stable dependency for the form's values (a new object every render).
  const body = JSON.stringify(form);
  useEffect(() => {
    if (!shown || posted.current) return;
    posted.current = true;
    fetcher.submit(JSON.parse(body) as Record<string, string>, { method: "POST" });
    // `fetcher` is stable for the component; one post per page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, body]);
}
