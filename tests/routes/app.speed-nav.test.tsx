/**
 * The Store speed nav entry (gc-wt3y) renders only while the feature is live:
 * app.tsx's layout shows the `/app/speed` link when its loader says
 * speedReportEnabled. AppProvider is stubbed to a passthrough.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, it, expect, vi } from "vitest";

vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/models/shop.server", () => ({}));
vi.mock("../../app/services/billing-reconciler.server", () => ({}));
vi.mock("../../app/services/journey-milestone.server", () => ({}));

import App from "../../app/routes/app";

function renderLayout(speedReportEnabled: boolean): string {
  const data = { apiKey: "k", speedReportEnabled };
  const Stub = createRoutesStub([
    { id: "app", path: "/app", Component: App as never, loader: () => data },
  ]);
  return renderToStaticMarkup(
    createElement(Stub, { initialEntries: ["/app"], hydrationData: { loaderData: { app: data } } }),
  );
}

describe("app layout nav", () => {
  it("shows Store speed when the feature is live", () => {
    const html = renderLayout(true);
    expect(html).toContain('<s-link href="/app/speed">Store speed</s-link>');
  });

  it("hides it while dark", () => {
    const html = renderLayout(false);
    expect(html).not.toContain("/app/speed");
    expect(html).toContain('<s-link href="/app/settings">Settings</s-link>');
  });
});
