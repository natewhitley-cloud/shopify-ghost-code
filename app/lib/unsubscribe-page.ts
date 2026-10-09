/**
 * Plain-HTML pages for the public unsubscribe route (gc-syz.7). The route is a
 * React Router RESOURCE route (see app/routes/unsubscribe.$token.tsx and
 * unsubscribe._index.tsx), so it returns these documents directly: no root
 * layout, no App Bridge.
 *
 * Every page is static and identical for any URL. The token is never
 * interpolated into the markup. The confirm page has ONE tiny inline script
 * (no external resources) that reads the token client-side from the URL
 * fragment (#t=...) or, for legacy links, the /unsubscribe/<token> path, puts
 * it in a hidden input and clears it from the address bar. The form POSTs the
 * token in the BODY to /unsubscribe, so it is never in a logged URL. The app's
 * only response header policy is Shopify's frame-ancestors CSP (no script-src),
 * and these responses set none, so an inline script is allowed.
 */

export const UNSUBSCRIBE_CONFIRM_HEADING = "Turn off Ghost Code summary emails for this store?";
export const UNSUBSCRIBE_DONE_HEADING = "Summary emails are off";
export const UNSUBSCRIBE_DONE_BODY = "You can turn them back on in Ghost Code > Settings.";
export const UNSUBSCRIBE_INVALID_HEADING = "This link is invalid or has expired";
export const UNSUBSCRIBE_INVALID_BODY =
  "To manage summary emails, open Ghost Code in your Shopify admin and go to Settings.";
export const UNSUBSCRIBE_NOSCRIPT_BODY =
  "This page needs JavaScript to turn emails off. Otherwise, open Ghost Code in your Shopify admin and turn them off in Ghost Code > Settings.";
export const UNSUBSCRIBE_ERROR_HEADING = "Something went wrong";
export const UNSUBSCRIBE_ERROR_BODY = "Please try again in a few minutes.";

/** Headers on every response: private, uncacheable, never indexed. */
export const UNSUBSCRIBE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
} as const;

function page(heading: string, body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading}</title>
</head>
<body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 480px; padding: 0 1rem;">
<h1 style="font-size: 1.5rem;">${heading}</h1>
<p>${body}</p>
${extra}</body>
</html>
`;
}

const CONFIRM_SCRIPT = `(function () {
  var t = "";
  var h = /^#t=([A-Za-z0-9_-]+)$/.exec(location.hash);
  var p = /^\\/unsubscribe\\/([A-Za-z0-9_-]+)\\/?$/.exec(location.pathname);
  if (h) t = h[1];
  else if (p) t = p[1];
  document.getElementById("token").value = t;
  if (t) history.replaceState(null, "", "/unsubscribe");
})();`;

/** GET page: asks for confirmation. Changes nothing; never looks the token up. */
export function renderConfirmPage(): string {
  return page(
    UNSUBSCRIBE_CONFIRM_HEADING,
    "You will stop receiving the summary email Ghost Code sends after scheduled scans.",
    `<form method="post" action="/unsubscribe">
<input type="hidden" id="token" name="token" value="">
<button type="submit" style="font-size: 1rem; padding: 0.5rem 1rem;">Turn off summary emails</button>
</form>
<noscript><p>${UNSUBSCRIBE_NOSCRIPT_BODY}</p></noscript>
<script>${CONFIRM_SCRIPT}</script>
`,
  );
}

export function renderDonePage(): string {
  return page(UNSUBSCRIBE_DONE_HEADING, UNSUBSCRIBE_DONE_BODY);
}

export function renderInvalidPage(): string {
  return page(UNSUBSCRIBE_INVALID_HEADING, UNSUBSCRIBE_INVALID_BODY);
}

export function renderErrorPage(): string {
  return page(UNSUBSCRIBE_ERROR_HEADING, UNSUBSCRIBE_ERROR_BODY);
}
