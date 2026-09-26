import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";

import { logger } from "../lib/logger.server";
import { OPS_EVENT_TYPES, recordOpsEvent } from "../models/ops-event.server";
import {
  getOrCreateShopMetadata,
  isLastSeenStale,
  reactivateShop,
  touchShopLastSeen,
} from "../models/shop.server";
import { isPlanReconcileStale, reconcileShopPlan } from "../services/billing-reconciler.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  // Create the Shop row on the first authenticated visit (covers the case where
  // the app/installed webhook isn't available). getOrCreateShopMetadata upserts
  // ONLY when the row is absent and tolerates the child route loader creating
  // it concurrently (gc-bj4). A freshly created row has uninstalledAt null, so
  // the reinstall branch below only fires for a pre-existing row.
  const shop = await getOrCreateShopMetadata(session.shop);
  if (shop?.uninstalledAt) {
    // Reinstall: the row exists but is still flagged uninstalled-pending-redact
    // (gc-grd stamps uninstalledAt instead of deleting). Clear the flag so the
    // shop rejoins the active set. This writes ONLY on an actual reinstall, not
    // on every load.
    await reactivateShop(session.shop);
    shop.uninstalledAt = null;
    // reactivateShop also nulls planReconciledAt in the DB; mirror it here so the
    // staleness check below fires a fresh reconcile on THIS load rather than
    // over-granting a possibly-stale plan for one more request (gc-bbb).
    shop.planReconciledAt = null;
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

  // Activity telemetry (gc): capture a durable "last login" and a per-navigation
  // page_visit on every authenticated merchant page load. Best-effort and
  // NON-BLOCKING — the page_visit write is fire-and-forget (not awaited) so it
  // never sits on the response critical path, and a telemetry failure must never
  // break the app load.
  const path = new URL(request.url).pathname;
  // Skip operator-only admin pages (gated by ADMIN_SHOP_DOMAINS) — that traffic
  // is the operator's own, not merchant activity. SEGMENT match (not a bare
  // prefix) so a future sibling like /app/administration can't be silently
  // swallowed by the skip.
  if (path !== "/app/admin" && !path.startsWith("/app/admin/")) {
    // Freshness-gated lastSeenAt stamp: write at most once per window so a
    // merchant clicking through pages doesn't write on every navigation. Wrapped
    // so a write failure never breaks the loader.
    if (shop && isLastSeenStale(shop.lastSeenAt)) {
      try {
        await touchShopLastSeen(shop.id);
      } catch (err) {
        logger.error("last-seen-touch-failed", {
          shop: session.shop,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // One page_visit per authenticated navigation. Fire-and-forget (NOT awaited)
    // so it never blocks the loader response — recordOpsEvent never throws (it
    // try/catches internally). Domain-keyed so GDPR redact (deleteShopData's
    // `key: domain` clause) reaches it.
    void recordOpsEvent({
      eventType: OPS_EVENT_TYPES.PAGE_VISIT,
      key: session.shop,
      metadata: { path },
    });
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
        <s-link href="/app/ignored">Ignored Findings</s-link>
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
