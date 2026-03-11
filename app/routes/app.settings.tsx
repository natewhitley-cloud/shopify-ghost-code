import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import { PLAN_STANDARD, PLAN_PROFESSIONAL } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { getPlanFeatures, PLANS } from "../lib/billing.server";

// ---------------------------------------------------------------------------
// Action — initiate a billing subscription request
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "subscribe-standard") {
    // Shopify redirects the merchant to the billing confirmation page.
    // billing.request() never returns — it throws a redirect response.
    await billing.request({
      plan: PLAN_STANDARD,
      isTest: process.env.NODE_ENV !== "production",
      returnUrl: `${process.env.SHOPIFY_APP_URL}/app/settings`,
    });
  }

  if (intent === "subscribe-professional") {
    await billing.request({
      plan: PLAN_PROFESSIONAL,
      isTest: process.env.NODE_ENV !== "production",
      returnUrl: `${process.env.SHOPIFY_APP_URL}/app/settings`,
    });
  }

  // Unknown intent — return a plain object so useActionData receives it.
  // Non-2xx responses are swallowed by React Router's useActionData, so we
  // return 200 with an error payload to ensure the error banner renders.
  return { error: "Unknown intent" };
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const features = getPlanFeatures(shop.plan);

  return { shop: { plan: shop.plan, domain: shop.domain }, features };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Settings() {
  const { shop, features } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const isFree = shop.plan === PLANS.FREE;
  const isStandard = shop.plan === PLANS.STANDARD;
  const isProfessional = shop.plan === PLANS.PROFESSIONAL;

  return (
    <s-page heading="Settings">
      <s-link slot="primary-action" href="/app">
        Back to Dashboard
      </s-link>

      {actionData?.error && <s-banner tone="critical">{actionData.error}</s-banner>}

      {/* Current Plan */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Current Plan</s-heading>
          <s-paragraph>
            You are on the <strong>{shop.plan}</strong> plan.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              {features.maxScansPerMonth === Infinity ? "Unlimited" : features.maxScansPerMonth}{" "}
              scans per month
            </s-list-item>
            <s-list-item>
              Finding details: {features.showFindingDetails ? "Yes" : "Count only"}
            </s-list-item>
            <s-list-item>
              Multiple themes: {features.maxThemes === Infinity ? "Yes" : "No"}
            </s-list-item>
            <s-list-item>Auto-rescan: {features.autoRescan ? "Yes" : "No"}</s-list-item>
            <s-list-item>Scan diffing: {features.scanDiffing ? "Yes" : "No"}</s-list-item>
          </s-unordered-list>
        </s-stack>
      </s-card>

      {/* Upgrade Plans — only shown when not on Professional */}
      {!isProfessional && (
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Upgrade Your Plan</s-heading>
            <s-paragraph>
              Unlock more scans, full finding details, and advanced features.
            </s-paragraph>

            {/* Standard plan — shown to Free users */}
            {isFree && (
              <s-stack direction="block" gap="base">
                <s-heading>Standard — $29 / month</s-heading>
                <s-unordered-list>
                  <s-list-item>Unlimited scans</s-list-item>
                  <s-list-item>Full finding details</s-list-item>
                  <s-list-item>7-day free trial</s-list-item>
                </s-unordered-list>
                <Form method="post">
                  <input type="hidden" name="intent" value="subscribe-standard" />
                  <button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? "Upgrading..." : "Upgrade to Standard"}
                  </button>
                </Form>
              </s-stack>
            )}

            {/* Professional plan — shown to Free and Standard users */}
            <s-stack direction="block" gap="base">
              <s-heading>Professional — $59 / month</s-heading>
              <s-unordered-list>
                <s-list-item>Everything in Standard</s-list-item>
                <s-list-item>Multiple theme scanning</s-list-item>
                <s-list-item>Auto-rescan on theme publish</s-list-item>
                <s-list-item>Scan diffing</s-list-item>
                <s-list-item>7-day free trial</s-list-item>
              </s-unordered-list>
              <Form method="post">
                <input type="hidden" name="intent" value="subscribe-professional" />
                <button type="submit" disabled={isSubmitting}>
                  {isSubmitting
                    ? "Upgrading..."
                    : isStandard
                      ? "Upgrade to Professional"
                      : "Start with Professional"}
                </button>
              </Form>
            </s-stack>
          </s-stack>
        </s-card>
      )}

      {/* Manage Subscription — shown only to paid-plan users */}
      {!isFree && (
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Manage Subscription</s-heading>
            <s-paragraph>
              To change or cancel your subscription, visit your Shopify admin billing settings.
            </s-paragraph>
            <s-paragraph>
              <s-text>
                If you cancel, your plan will revert to Free at the end of your current billing
                period.
              </s-text>
            </s-paragraph>
          </s-stack>
        </s-card>
      )}

      {/* About */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>About Ghost Code</s-heading>
          <s-paragraph>
            Ghost Code scans your Shopify themes for leftover code from uninstalled apps. This
            orphaned code can slow down your store, break functionality, and create security risks.
          </s-paragraph>
          <s-paragraph>
            <s-text>Version: 1.0.0</s-text>
          </s-paragraph>
        </s-stack>
      </s-card>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
