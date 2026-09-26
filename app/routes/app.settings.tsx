import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { buildPricingPlansUrl, getPlanFeatures } from "../lib/billing.server";
import {
  allOptionalScopesGranted,
  missingOptionalScopes,
  OPTIONAL_SCOPE_INFO,
  OPTIONAL_SCOPES,
} from "../lib/optional-scopes";
import { PLANS } from "../lib/plans";
import { upgradeCtaLabel } from "../lib/trial-cta";
import { getShopMetadata } from "../models/shop.server";
import { getTrialEligibility } from "../services/trial-eligibility.server";
import { authenticate } from "../shopify.server";
import {
  BORDER_DEFAULT,
  BG_WHITE,
  COLOR_INFO,
  groundStyle,
  hairline,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
} from "../styles/shared";

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

  // Shopify Managed Pricing — plan changes happen on Shopify's native UI.
  const pricingPlansUrl = buildPricingPlansUrl(session.shop);

  // gc-97k.8: promise the free trial only to a Free shop with no paid history.
  const trialEligible = await getTrialEligibility(shop);

  return {
    shop: { plan: shop.plan, domain: shop.domain },
    features,
    pricingPlansUrl,
    trialEligible,
  };
};

// ---------------------------------------------------------------------------
// Permissions card (client-side, Standard+ only)
// ---------------------------------------------------------------------------

/**
 * The `shopify` global is injected by App Bridge in embedded context. The
 * `scopes` API is relatively new, so it is typed optional and guarded at runtime
 * — on an older App Bridge `shopify.scopes` is undefined and the card degrades
 * to an informational note rather than throwing.
 *
 * Shapes verified against the App Home Scopes API docs
 * (shopify.dev/docs/api/app-home/v1.0/apis/authentication-and-data/scopes-api):
 *   - query()   → { granted, required, optional }  (string[] each)
 *   - request() → { result: "granted-all" | "declined-all", detail: { granted } }
 */
declare const shopify:
  | {
      scopes?: {
        query: () => Promise<{ granted: string[]; required: string[]; optional: string[] }>;
        request: (
          scopes: string[],
        ) => Promise<{ result: "granted-all" | "declined-all"; detail: { granted: string[] } }>;
      };
    }
  | undefined;

/**
 * The badge treatment for one optional scope, derived from the App Bridge query
 * result. When `granted` is null we never successfully read the grant state (the
 * initial `shopify.scopes.query()` rejected), so we render a neutral "Status
 * unavailable" badge rather than falsely asserting "Not granted" — a query
 * failure is not proof the scope is missing. Pure + exported for unit testing.
 */
export function scopeBadge(
  granted: string[] | null,
  scope: string,
): { tone: "success" | "warning" | "neutral"; text: string } {
  if (granted === null) return { tone: "neutral", text: "Status unavailable" };
  return granted.includes(scope)
    ? { tone: "success", text: "Granted" }
    : { tone: "warning", text: "Not granted" };
}

/**
 * Live granted-scope state for the optional per-audit scopes, with a re-consent
 * button that opens the App Bridge permission modal for only the missing scopes.
 * Rendered only for Standard+ plans (the Admin-resource detectors these scopes
 * unlock are paid features, so Free merchants never see this card).
 */
function PermissionsCard() {
  // null = not yet loaded; string[] = App Bridge query result.
  const [granted, setGranted] = useState<string[] | null>(null);
  // true when the App Bridge scopes API is unavailable (older App Bridge).
  const [unsupported, setUnsupported] = useState(false);
  // true when the initial query or a request failed.
  const [failed, setFailed] = useState(false);
  const [requesting, setRequesting] = useState(false);

  // Query current scopes on mount. Runs only in the browser (App Bridge global),
  // so the SSR render never touches `shopify`.
  useEffect(() => {
    if (typeof shopify === "undefined" || !shopify.scopes) {
      setUnsupported(true);
      return;
    }
    let cancelled = false;
    shopify.scopes
      .query()
      .then((res) => {
        if (!cancelled) setGranted(res.granted);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const missing = missingOptionalScopes(granted ?? []);

  async function handleGrant() {
    if (typeof shopify === "undefined" || !shopify.scopes) return;
    setRequesting(true);
    setFailed(false);
    try {
      await shopify.scopes.request(missing);
      // Re-query so the displayed state reflects the merchant's decision (the
      // modal is all-or-nothing, but re-querying is the authoritative source).
      const res = await shopify.scopes.query();
      setGranted(res.granted);
    } catch {
      setFailed(true);
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div style={{ marginTop: "16px" }}>
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Permissions</s-heading>
          <s-paragraph>
            Some checks (products, pages, redirects, and translations) need extra read-only
            permissions. Grant them to include those checks in your scans.
          </s-paragraph>

          {unsupported ? (
            <s-paragraph>
              <span style={{ color: TEXT_SUBDUED }}>
                Permission status is unavailable in this view. Reload the app from your Shopify
                admin to manage permissions.
              </span>
            </s-paragraph>
          ) : granted === null && !failed ? (
            <s-paragraph>
              <span style={{ color: TEXT_SUBDUED }}>Checking permissions…</span>
            </s-paragraph>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  borderTop: `1px solid ${BORDER_DEFAULT}`,
                  paddingTop: "12px",
                }}
              >
                {OPTIONAL_SCOPES.map((scope) => {
                  // When the query failed (granted === null) this renders a
                  // neutral "Status unavailable" badge instead of a false
                  // "Not granted" — we couldn't read the real grant state.
                  const badge = scopeBadge(granted, scope);
                  const info = OPTIONAL_SCOPE_INFO[scope];
                  return (
                    <div
                      key={scope}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: "12px",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, color: TEXT_PRIMARY }}>{info.label}</div>
                        <div style={{ fontSize: "13px", color: TEXT_SUBDUED }}>{info.unlocks}</div>
                      </div>
                      <s-badge tone={badge.tone}>{badge.text}</s-badge>
                    </div>
                  );
                })}
              </div>

              {granted !== null && allOptionalScopesGranted(granted) ? (
                <s-banner tone="success">
                  All permissions granted — every check runs on your scans.
                </s-banner>
              ) : (
                <div>
                  <s-button variant="primary" onClick={handleGrant} disabled={requesting}>
                    {requesting ? "Requesting…" : "Grant access"}
                  </s-button>
                </div>
              )}

              {failed && (
                <s-banner tone="critical">
                  Something went wrong updating permissions. Please try again.
                </s-banner>
              )}
            </>
          )}
        </s-stack>
      </s-card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Settings() {
  const { shop, pricingPlansUrl, trialEligible } = useLoaderData<typeof loader>();

  const isFree = shop.plan === PLANS.FREE;
  const isStandard = shop.plan === PLANS.STANDARD;
  const isProfessional = shop.plan === PLANS.PROFESSIONAL;

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
      <div style={hairline} />
      <div style={groundStyle}>
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
                <s-list-item>First scan always free</s-list-item>
                <s-list-item>1 scan per month after first</s-list-item>
                <s-list-item>Findings grouped by impact, with counts</s-list-item>
                <s-list-item>Preview of top finding in full</s-list-item>
                <s-list-item>Single theme scanning</s-list-item>
              </s-unordered-list>
            </div>
          </div>

          {/* Standard Plan */}
          <div className={`plan-tile${isStandard ? " plan-tile--current" : ""}`}>
            <div className="plan-tile__header">
              <p className="plan-tile__name">Standard</p>
              <p className="plan-tile__price">$9 / month</p>
              {isStandard && <span className="plan-tile__badge">Current plan</span>}
            </div>
            <hr className="plan-tile__divider" />
            <div className="plan-tile__features">
              <s-unordered-list>
                <s-list-item>All features in Free</s-list-item>
                <s-list-item>Full finding details with code</s-list-item>
                <s-list-item>1 manual scan per week</s-list-item>
                <s-list-item>Findings trend over time</s-list-item>
                <s-list-item>7-day free trial</s-list-item>
              </s-unordered-list>
            </div>
            {!isStandard &&
              planButton(
                isFree
                  ? upgradeCtaLabel(PLANS.STANDARD, trialEligible)
                  : isProfessional
                    ? "Downgrade to Standard"
                    : "Select",
                isProfessional ? "secondary" : "primary",
              )}
          </div>

          {/* Professional Plan */}
          <div className={`plan-tile${isProfessional ? " plan-tile--current" : ""}`}>
            <div className="plan-tile__header">
              <p className="plan-tile__name">Professional</p>
              <p className="plan-tile__price">$29 / month</p>
              {isProfessional && <span className="plan-tile__badge">Current plan</span>}
            </div>
            <hr className="plan-tile__divider" />
            <div className="plan-tile__features">
              <s-unordered-list>
                <s-list-item>All features in Standard</s-list-item>
                <s-list-item>Unlimited scans</s-list-item>
                <s-list-item>Unlimited theme scanning</s-list-item>
                <s-list-item>Auto-rescan on theme publish</s-list-item>
                <s-list-item>Scan diffing (New/Resolved)</s-list-item>
                <s-list-item>7-day free trial</s-list-item>
              </s-unordered-list>
            </div>
            {!isProfessional && planButton(upgradeCtaLabel(PLANS.PROFESSIONAL, trialEligible))}
          </div>
        </div>

        {/* Manage subscription */}
        <div style={{ marginTop: "32px" }}>
          <s-card>
            <s-stack direction="block" gap="base">
              <s-heading>Manage Subscription</s-heading>
              <s-paragraph>
                Select a plan above to upgrade or downgrade. To cancel your subscription and return
                to the Free plan, use the link below.
              </s-paragraph>
              <div>
                <a href={pricingPlansUrl} target="_top" rel="noreferrer">
                  <s-button>Manage subscription in Shopify</s-button>
                </a>
              </div>
            </s-stack>
          </s-card>
        </div>

        {/* Permissions — Standard+ only (the checks these scopes unlock are paid). */}
        {!isFree && <PermissionsCard />}

        {/* About */}
        <div style={{ marginTop: "16px" }} />
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>About Ghost Code</s-heading>
            <s-paragraph>
              Ghost Code scans your Shopify themes for leftover code from uninstalled apps. This
              orphaned code can slow down your store, break functionality, and create security
              risks.
            </s-paragraph>
            <s-paragraph>
              <s-text>Version: 1.0.0</s-text>
            </s-paragraph>
          </s-stack>
        </s-card>
      </div>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
