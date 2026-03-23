import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";

import { getPlanFeatures } from "../lib/billing.server";
import { PLANS } from "../lib/plans";
import { getShopByDomain } from "../models/shop.server";
import { authenticate, PLAN_STANDARD, PLAN_PROFESSIONAL } from "../shopify.server";

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
  const { shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const isFree = shop.plan === PLANS.FREE;
  const isStandard = shop.plan === PLANS.STANDARD;
  const isProfessional = shop.plan === PLANS.PROFESSIONAL;

  return (
    <s-page heading="Billing">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>

      {actionData?.error && <s-banner tone="critical">{actionData.error}</s-banner>}

      {/* Plan Tiles — 3 columns, responsive */}
      <style>{`
        .plan-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 16px;
          margin-top: 8px;
        }
        .plan-tile {
          border: 1px solid #e1e3e5;
          border-radius: 12px;
          padding: 24px;
          background: #ffffff;
          display: flex;
          flex-direction: column;
          min-height: 300px;
        }
        .plan-tile--current {
          border: 2px solid #2c6ecb;
          box-shadow: 0 0 0 1px #2c6ecb;
        }
        .plan-tile__header {
          height: 100px;
          margin-bottom: 4px;
        }
        .plan-tile__name {
          font-size: 22px;
          font-weight: 700;
          color: #202223;
          margin: 0;
        }
        .plan-tile__price {
          font-size: 16px;
          font-weight: 600;
          color: #6d7175;
          margin: 4px 0 0 0;
        }
        .plan-tile__badge {
          display: inline-block;
          background: #2c6ecb;
          color: #ffffff;
          font-size: 12px;
          font-weight: 600;
          padding: 3px 10px;
          border-radius: 12px;
          margin-top: 8px;
        }
        .plan-tile__divider {
          border: none;
          border-top: 1px solid #e1e3e5;
          margin: 16px 0;
        }
        .plan-tile__features {
          flex: 1;
        }
        .plan-tile__action {
          margin-top: 16px;
        }
      `}</style>
      <s-heading>Plans</s-heading>
      <div className="plan-grid">
        {/* Free Plan */}
        <div className={`plan-tile${isFree ? " plan-tile--current" : ""}`}>
          <div className="plan-tile__header">
            <p className="plan-tile__name">Free</p>
            <p className="plan-tile__price">$0 / month</p>
            {isFree && <span className="plan-tile__badge">Current plan</span>}
          </div>
          <hr className="plan-tile__divider" />
          <div className="plan-tile__features">
            <s-unordered-list>
              <s-list-item>1 scan per month</s-list-item>
              <s-list-item>Finding count only</s-list-item>
              <s-list-item>Single theme</s-list-item>
            </s-unordered-list>
          </div>
        </div>

        {/* Standard Plan */}
        <div className={`plan-tile${isStandard ? " plan-tile--current" : ""}`}>
          <div className="plan-tile__header">
            <p className="plan-tile__name">Standard</p>
            <p className="plan-tile__price">$29 / month</p>
            {isStandard && <span className="plan-tile__badge">Current plan</span>}
          </div>
          <hr className="plan-tile__divider" />
          <div className="plan-tile__features">
            <s-unordered-list>
              <s-list-item>1 scan per week</s-list-item>
              <s-list-item>Full finding details</s-list-item>
              <s-list-item>Single theme</s-list-item>
              <s-list-item>7-day free trial</s-list-item>
            </s-unordered-list>
          </div>
          {isFree && (
            <div className="plan-tile__action">
              <Form method="post">
                <input type="hidden" name="intent" value="subscribe-standard" />
                <s-button variant="primary" type="submit" disabled={isSubmitting || undefined}>
                  {isSubmitting ? "Upgrading..." : "Upgrade to Standard"}
                </s-button>
              </Form>
            </div>
          )}
        </div>

        {/* Professional Plan */}
        <div className={`plan-tile${isProfessional ? " plan-tile--current" : ""}`}>
          <div className="plan-tile__header">
            <p className="plan-tile__name">Professional</p>
            <p className="plan-tile__price">$49 / month</p>
            {isProfessional && <span className="plan-tile__badge">Current plan</span>}
          </div>
          <hr className="plan-tile__divider" />
          <div className="plan-tile__features">
            <s-unordered-list>
              <s-list-item>Everything in Standard</s-list-item>
              <s-list-item>Multiple theme scanning</s-list-item>
              <s-list-item>Auto-rescan on theme publish</s-list-item>
              <s-list-item>Automatic daily scans</s-list-item>
              <s-list-item>Scan diffing</s-list-item>
              <s-list-item>7-day free trial</s-list-item>
            </s-unordered-list>
          </div>
          {!isProfessional && (
            <div className="plan-tile__action">
              <Form method="post">
                <input type="hidden" name="intent" value="subscribe-professional" />
                <s-button variant="primary" type="submit" disabled={isSubmitting || undefined}>
                  {isSubmitting ? "Upgrading..." : "Upgrade to Professional"}
                </s-button>
              </Form>
            </div>
          )}
        </div>
      </div>

      {/* Manage Subscription — shown only to paid-plan users */}
      {!isFree && (
        <div style={{ marginTop: "32px" }}>
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
        </div>
      )}

      {/* About */}
      <div style={{ marginTop: "16px" }} />
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
