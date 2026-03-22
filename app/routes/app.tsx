import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";

import { getPlanFeatures } from "../lib/billing.server";
import { getShopByDomain, upsertShop } from "../models/shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  let shop = await getShopByDomain(session.shop);
  if (!shop) {
    // Shop record doesn't exist yet — create it on first authenticated visit.
    // This covers the case where the app/installed webhook isn't available.
    shop = await upsertShop(session.shop, session.accessToken ?? "");
  }
  const features = getPlanFeatures(shop.plan);

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    permissionAuditEnabled: features.permissionAuditEnabled,
  };
};

export default function App() {
  const { apiKey, permissionAuditEnabled } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/scans">Scan History</s-link>
        {permissionAuditEnabled && <s-link href="/app/permissions">Permission Audit</s-link>}
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
