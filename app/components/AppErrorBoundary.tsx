import { isRouteErrorResponse, useRouteError } from "react-router";

/**
 * Shared route-level error boundary used across all app routes.
 *
 * Renders a Polaris-compatible error page for both HTTP error responses
 * (4xx/5xx) and unexpected runtime errors.
 *
 * Usage in route modules:
 *   export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
 */
export function AppErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <s-page heading={`Error ${error.status}`}>
        <s-card>
          <s-banner tone="critical">
            <s-paragraph>{error.statusText || "Something went wrong"}</s-paragraph>
          </s-banner>
        </s-card>
      </s-page>
    );
  }

  return (
    <s-page heading="Error">
      <s-card>
        <s-banner tone="critical">
          <s-paragraph>An unexpected error occurred. Please try again.</s-paragraph>
        </s-banner>
      </s-card>
    </s-page>
  );
}
