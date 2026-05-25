import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { getPlanFeatures } from "../lib/billing.server";
import { PLANS } from "../lib/plans";
import { getShopMetadata } from "../models/shop.server";
import { authenticate } from "../shopify.server";
import { BORDER_DEFAULT, BG_WHITE, COLOR_INFO, TEXT_PRIMARY, TEXT_SUBDUED } from "../styles/shared";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const features = getPlanFeatures(shop.plan);

  return { shop: { plan: shop.plan, domain: shop.domain }, features, shopDomain: session.shop };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Charge ID from the Shopify Partner Dashboard (Partners → Apps → Ghost Code → Pricing).
const GHOST_CODE_CHARGE_ID = "3e80de5fa6065400e94de3f1fe7f0c8b";

export default function Settings() {
  const { shop, shopDomain } = useLoaderData<typeof loader>();

  const isFree = shop.plan === PLANS.FREE;
  const isStandard = shop.plan === PLANS.STANDARD;
  const isProfessional = shop.plan === PLANS.PROFESSIONAL;

  // Shopify Managed Pricing — plan changes happen on Shopify's native UI.
  const pricingPlansUrl = `https://${shopDomain}/admin/charges/${GHOST_CODE_CHARGE_ID}/pricing_plans`;

  function planButton(label: string, variant: "primary" | "secondary" = "primary") {
    return (
      <div style={{ marginTop: "16px" }}>
        <a href={pricingPlansUrl} target="_top" rel="noreferrer">
          <s-button variant={variant}>{label}</s-button>
        </a>
      </div>
    );
  }

  return (
    <s-page heading="Billing">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>

      {/* Plan Tiles — 3 columns, responsive */}
      <style>{`
        .plan-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 16px;
          margin-top: 8px;
        }
        .plan-tile {
          border: 1px solid ${BORDER_DEFAULT};
          border-radius: 12px;
          padding: 24px;
          background: ${BG_WHITE};
          display: flex;
          flex-direction: column;
          min-height: 300px;
        }
        .plan-tile--current {
          border: 2px solid ${COLOR_INFO};
          box-shadow: 0 0 0 1px ${COLOR_INFO};
        }
        .plan-tile__header {
          height: 100px;
          margin-bottom: 4px;
        }
        .plan-tile__name {
          font-size: 22px;
          font-weight: 700;
          color: ${TEXT_PRIMARY};
          margin: 0;
        }
        .plan-tile__price {
          font-size: 16px;
          font-weight: 600;
          color: ${TEXT_SUBDUED};
          margin: 4px 0 0 0;
        }
        .plan-tile__badge {
          display: inline-block;
          background: ${COLOR_INFO};
          color: ${BG_WHITE};
          font-size: 12px;
          font-weight: 600;
          padding: 3px 10px;
          border-radius: 12px;
          margin-top: 8px;
        }
        .plan-tile__divider {
          border: none;
          border-top: 1px solid ${BORDER_DEFAULT};
          margin: 16px 0;
        }
        .plan-tile__features {
          flex: 1;
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
              <s-list-item>Full finding details with code</s-list-item>
              <s-list-item>Theme Health Score + delta</s-list-item>
              <s-list-item>Single theme</s-list-item>
              <s-list-item>7-day free trial</s-list-item>
            </s-unordered-list>
          </div>
          {!isStandard &&
            planButton(
              isFree ? "Start Free Trial" : isProfessional ? "Downgrade to Standard" : "Select",
              isProfessional ? "secondary" : "primary",
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
          {!isProfessional && planButton(isFree ? "Start Free Trial" : "Upgrade to Professional")}
        </div>
      </div>

      {/* Manage subscription */}
      <div style={{ marginTop: "32px" }}>
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Manage Subscription</s-heading>
            <s-paragraph>
              Select a plan above to upgrade or downgrade. To cancel your subscription and return to
              the Free plan, use the link below.
            </s-paragraph>
            <div>
              <a href={pricingPlansUrl} target="_top" rel="noreferrer">
                <s-button>Manage subscription in Shopify</s-button>
              </a>
            </div>
          </s-stack>
        </s-card>
      </div>

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
