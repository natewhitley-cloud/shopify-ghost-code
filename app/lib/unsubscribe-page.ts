/**
 * Plain-HTML pages for the public unsubscribe route (gc-syz.7). The route is a
 * React Router RESOURCE route (see app/routes/unsubscribe.$token.tsx), so it
 * returns these documents directly: no root layout, no App Bridge, no scripts.
 *
 * Every page is static. The token is never interpolated into the markup: the
 * confirm form posts to "" (the current URL), so there is nothing to escape and
 * nothing for a page cache or log to capture.
 */

export const UNSUBSCRIBE_CONFIRM_HEADING = "Turn off Ghost Code monitoring emails for this store?";
export const UNSUBSCRIBE_DONE_HEADING = "Monitoring emails are off";
export const UNSUBSCRIBE_DONE_BODY = "You can turn them back on in Ghost Code > Settings.";
export const UNSUBSCRIBE_INVALID_HEADING = "This link is invalid or has expired";
export const UNSUBSCRIBE_INVALID_BODY =
  "To manage monitoring emails, open Ghost Code in your Shopify admin and go to Settings.";
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

/** GET page: asks for confirmation. Changes nothing; never looks the token up. */
export function renderConfirmPage(): string {
  return page(
    UNSUBSCRIBE_CONFIRM_HEADING,
    "You will stop receiving emails when a rescan finds new leftover code.",
    `<form method="post" action="">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit" style="font-size: 1rem; padding: 0.5rem 1rem;">Turn off monitoring emails</button>
</form>
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
