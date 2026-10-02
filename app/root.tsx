import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Root error boundary for stray visitors (unmatched URLs, scanners). Without it
 * React Router's DefaultErrorComponent runs: it console.errors the full error
 * (floods Railway's log rate limit) and renders error.stack into the page.
 * (gc-6lw)
 *
 * Deliberately logs NOTHING: real errors are already logged and recorded by
 * handleError in entry.server.tsx. Never renders error.message or the stack.
 * Routes under /app have their own boundaries (nearest boundary wins).
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);
  const heading = isResponse
    ? `${error.status} ${error.statusText}`.trim()
    : "Something went wrong";
  const message = isResponse
    ? "The page you requested could not be found or is not available."
    : "An unexpected error occurred. Please try again later.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{heading}</title>
        <Meta />
        <Links />
      </head>
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "4rem auto", maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.5rem" }}>{heading}</h1>
        <p>{message}</p>
        <Scripts />
      </body>
    </html>
  );
}
