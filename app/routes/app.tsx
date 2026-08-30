import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";

import { logger } from "../lib/logger.server";
import { getShopMetadata, reactivateShop, upsertShop } from "../models/shop.server";
import { isPlanReconcileStale, reconcileShopPlan } from "../services/billing-reconciler.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  let shop = await getShopMetadata(session.shop);
  if (!shop) {
    // Shop record doesn't exist yet — create it on first authenticated visit.
    // This covers the case where the app/installed webhook isn't available.
    await upsertShop(session.shop);
    shop = await getShopMetadata(session.shop);
  } else if (shop.uninstalledAt) {
    // Reinstall: the row exists but is still flagged uninstalled-pending-redact
    // (gc-grd stamps uninstalledAt instead of deleting). Clear the flag so the
    // shop rejoins the active set. This writes ONLY on an actual reinstall, not
    // on every load.
    await reactivateShop(session.shop);
    shop.uninstalledAt = null;
  }

  // Plan reconciliation (CMP-2 / GC-fur). The APP_SUBSCRIPTIONS_UPDATE webhook
  // that used to write plan state is DEAD as of 2026-04-28, so plan state is now
  // driven entirely from here:
  //   - Redirect fast-path: when a merchant selects/confirms a plan, Shopify
  //     redirects back with a `plan_handle` param. Its PRESENCE forces an
  //     immediate reconcile (bypassing the freshness guard) so an upgrade is
  //     granted right away. We never trust the param's VALUE — reconcileShopPlan
  //     re-queries Shopify's active subscriptions as the sole source of truth.
  //   - Backstop: otherwise reconcile only when the stored plan is stale.
  // Wrapped in try/catch — reconciliation must NEVER break the app load; on any
  // error we log and continue with the stored plan.
  const redirectTriggered = new URL(request.url).searchParams.has("plan_handle");
  if (shop && (redirectTriggered || isPlanReconcileStale(shop.planReconciledAt))) {
    try {
      // recordEvent only on the merchant-initiated redirect path — routine stale
      // reconciles must not pollute conversion/churn analytics.
      await reconcileShopPlan(
        admin,
        { domain: shop.domain, plan: shop.plan },
        { recordEvent: redirectTriggered },
      );
    } catch (err) {
      logger.error("billing-reconcile-loader-failed", {
        shop: session.shop,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/scans">Scan History</s-link>
        <s-link href="/app/settings">Billing</s-link>
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
