import type { ActionFunctionArgs } from "react-router";

import { handleUnsubscribePost, htmlResponse } from "../lib/unsubscribe-action.server";
import { renderConfirmPage } from "../lib/unsubscribe-page";

/**
 * Public unsubscribe for the human link in merchant monitoring emails
 * (gc-252x): /unsubscribe#t=<token>. The token is in the URL FRAGMENT, which a
 * browser never sends, so it is not in access logs. The confirm page reads it
 * client-side and POSTs it back here in the request BODY. Same resource-route
 * reasoning (no CSRF check, no ambient credential) as unsubscribe.$token.tsx.
 */

export const loader = async () => htmlResponse(renderConfirmPage());

export const action = async ({ request }: ActionFunctionArgs) => handleUnsubscribePost(request, "");
