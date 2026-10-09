import type { ActionFunctionArgs } from "react-router";

import { handleUnsubscribePost, htmlResponse } from "../lib/unsubscribe-action.server";
import { renderConfirmPage } from "../lib/unsubscribe-page";

/**
 * Public tokenized unsubscribe for merchant summary emails (gc-syz.7).
 * This path form is the RFC 8058 List-Unsubscribe header target, so it must
 * identify the shop on its own. The human link in the email body is the
 * fragment form handled by unsubscribe._index.tsx.
 *
 * Deliberately a RESOURCE route (no default export) outside the authenticated
 * app.* tree: no authenticate.admin, no App Bridge, and it returns plain HTML.
 * The 256-bit token is the only credential.
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
 * infeasible.
 *
 * What is and is not logged: the access log (server.mjs) masks this path's
 * token segment, /unsubscribe/[REDACTED] (gc-t7o2); before that,
 * react-router-serve logged the full URL. Our own code never logs it
 * (handleError is bypassed, no handler logs). Defense in depth: a successful
 * unsubscribe ROTATES the token (disableAlertsByToken), so a token that
 * reached an older log is already dead. The confirm form POSTs the token to
 * /unsubscribe in the body, so a human click does not log it again.
 */

export const loader = async () => htmlResponse(renderConfirmPage());

export const action = async ({ request, params }: ActionFunctionArgs) =>
  handleUnsubscribePost(request, params.token ?? "");
