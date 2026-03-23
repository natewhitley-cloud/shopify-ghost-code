/**
 * Tests for app/components/AppErrorBoundary.tsx
 *
 * Since we don't have a DOM testing library (jsdom/happy-dom), these tests
 * verify that the component function executes without throwing for each
 * error type. React-router hooks are mocked to simulate different error states.
 */

import { isRouteErrorResponse, useRouteError } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("react-router", () => ({
  useRouteError: vi.fn(),
  isRouteErrorResponse: vi.fn(),
}));

import { AppErrorBoundary } from "../../app/components/AppErrorBoundary";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockUseRouteError = useRouteError as ReturnType<typeof vi.fn>;
const mockIsRouteErrorResponse = isRouteErrorResponse as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Route error responses (4xx/5xx)
// ---------------------------------------------------------------------------

describe("AppErrorBoundary — route error responses", () => {
  it("does not throw for a 404 route error response", () => {
    const routeError = { status: 404, statusText: "Not Found", data: null };
    mockUseRouteError.mockReturnValue(routeError);
    mockIsRouteErrorResponse.mockReturnValue(true);

    expect(() => AppErrorBoundary()).not.toThrow();
  });

  it("returns JSX containing the error status for a 404", () => {
    const routeError = { status: 404, statusText: "Not Found", data: null };
    mockUseRouteError.mockReturnValue(routeError);
    mockIsRouteErrorResponse.mockReturnValue(true);

    const result = AppErrorBoundary();
    // The component renders <s-page heading={`Error ${error.status}`}>
    expect(result).toBeTruthy();
    expect(result.props.heading).toBe("Error 404");
  });

  it("does not throw for a 500 route error response", () => {
    const routeError = { status: 500, statusText: "Internal Server Error", data: null };
    mockUseRouteError.mockReturnValue(routeError);
    mockIsRouteErrorResponse.mockReturnValue(true);

    expect(() => AppErrorBoundary()).not.toThrow();
  });

  it("returns JSX containing the error status for a 500", () => {
    const routeError = { status: 500, statusText: "Internal Server Error", data: null };
    mockUseRouteError.mockReturnValue(routeError);
    mockIsRouteErrorResponse.mockReturnValue(true);

    const result = AppErrorBoundary();
    expect(result.props.heading).toBe("Error 500");
  });

  it("does not throw for a route error with empty statusText", () => {
    const routeError = { status: 403, statusText: "", data: null };
    mockUseRouteError.mockReturnValue(routeError);
    mockIsRouteErrorResponse.mockReturnValue(true);

    expect(() => AppErrorBoundary()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unexpected errors (non-route-error)
// ---------------------------------------------------------------------------

describe("AppErrorBoundary — unexpected errors", () => {
  it("does not throw for a generic Error object", () => {
    mockUseRouteError.mockReturnValue(new Error("Something broke"));
    mockIsRouteErrorResponse.mockReturnValue(false);

    expect(() => AppErrorBoundary()).not.toThrow();
  });

  it("renders the generic error page heading for non-route errors", () => {
    mockUseRouteError.mockReturnValue(new Error("Something broke"));
    mockIsRouteErrorResponse.mockReturnValue(false);

    const result = AppErrorBoundary();
    expect(result.props.heading).toBe("Error");
  });

  it("does not throw for a string error", () => {
    mockUseRouteError.mockReturnValue("unexpected string error");
    mockIsRouteErrorResponse.mockReturnValue(false);

    expect(() => AppErrorBoundary()).not.toThrow();
  });

  it("does not throw for null error", () => {
    mockUseRouteError.mockReturnValue(null);
    mockIsRouteErrorResponse.mockReturnValue(false);

    expect(() => AppErrorBoundary()).not.toThrow();
  });

  it("does not throw for undefined error", () => {
    mockUseRouteError.mockReturnValue(undefined);
    mockIsRouteErrorResponse.mockReturnValue(false);

    expect(() => AppErrorBoundary()).not.toThrow();
  });
});
