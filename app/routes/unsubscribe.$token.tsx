import type { ActionFunctionArgs } from "react-router";

import {
  renderConfirmPage,
  renderDonePage,
  renderErrorPage,
  renderInvalidPage,
  UNSUBSCRIBE_HEADERS,
} from "../lib/unsubscribe-page";
import { disableAlertsByToken } from "../models/merchant-alert.server";

/**
 * Public tokenized unsubscribe for merchant monitoring emails (gc-syz.7).
 *
 * Deliberately a RESOURCE route (no default export) outside the authenticated
 * app.* tree: no authenticate.admin, no App Bridge, and it returns plain HTML.
 * The 256-bit token in the URL is the only credential.
 *
 * Why a resource route and not a document route with an action: react-router
 * runs its Origin-based CSRF check (throwIfPotentialCSRFAttack) on every
 * mutation to a DOCUMENT route, and rejects a literal `Origin: null` and any
 * foreign Origin with a 400. RFC 8058 one-click POSTs come from mail providers,
 * usually with no Origin, but some clients send `null` or their own origin.
 * Resource routes skip that check. Skipping it is safe here: the only effect of
 * a forged POST is turning OFF one shop's emails, and it needs the unguessable
 * token, so there is no ambient credential (cookie, session) for a cross-site
 * request to ride on. A resource route cannot export an ErrorBoundary, so the
 * handlers catch and render their own error page instead (architecture rule:
 * every user-facing route degrades to a page, never a stack trace).
 *
 * GET never changes state: corporate link scanners (Outlook Safe Links, etc.)
 * prefetch every link in an email, and a state-changing GET would unsubscribe
 * people who never clicked. GET renders the confirm page WITHOUT a token
 * lookup, so it is not an oracle for which tokens exist. POST is the oracle by
 * necessity (it must report failure), but guessing a valid 256-bit token is
 * infeasible. Tokens are never logged.
 */

function html(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...UNSUBSCRIBE_HEADERS, ...extraHeaders } });
}

export const loader = async () => html(renderConfirmPage());

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return html(renderInvalidPage(), 405, { Allow: "GET, HEAD, POST" });
  }
  try {
    const disabled = await disableAlertsByToken(params.token ?? "");
    return disabled ? html(renderDonePage()) : html(renderInvalidPage(), 404);
  } catch {
    // No token or error detail is logged or rendered; handleError is bypassed on
    // purpose because it would record the request URL (which contains the token).
    return html(renderErrorPage(), 500);
  }
};
