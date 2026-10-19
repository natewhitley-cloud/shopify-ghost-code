import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";

import { PlanTile } from "../components/PlanTile";
import { readChecked } from "../components/polaris-events";
import { buildPricingPlansUrl, getPlanFeatures } from "../lib/billing.server";
import {
  allOptionalScopesGranted,
  BROKEN_LINKS_STANDARD_NOTE,
  OPTIONAL_SCOPE_INFO,
  OPTIONAL_SCOPES,
  optionalScopeUnlocks,
} from "../lib/optional-scopes";
import { canReceiveAlerts } from "../lib/plan-gating.server";
import { PLAN_TILE_META, planTileBullets, planTileCta, TILE_PLANS } from "../lib/plan-tiles";
import { PLANS } from "../lib/plans";
import {
  SUMMARY_CARD_HEADING,
  SUMMARY_COMING_SOON,
  SUMMARY_FREE_PARAGRAPH,
  SUMMARY_NOT_IN_PLAN,
  SUMMARY_SAVED_OFF,
  SUMMARY_SAVED_ON,
  SUMMARY_SAVED_ON_DARK,
  summaryEffectivelyOn,
  summaryLiveParagraph,
  summaryToggleLabel,
} from "../lib/summary-email-copy";
import { upgradeCtaLabel } from "../lib/trial-cta";
import { useOptionalScopes } from "../lib/use-optional-scopes";
import { setSummaryEmailsEnabled } from "../models/merchant-alert.server";
import { getShopMetadata } from "../models/shop.server";
import { getMerchantAlertConfigStatus } from "../services/merchant-alert.server";
import { isSpeedReportLive } from "../services/speed-report-config.server";
import { getTrialEligibility } from "../services/trial-eligibility.server";
import { authenticate } from "../shopify.server";
import {
  groundStyle,
  hairline,
  sectionCard,
  sectionHeader,
  styles,
  SUCCESS_TEXT_STRONG,
  TABLE_BG_STRIPE,
  TEXT_PRIMARY,
  textSubdued,
  textSubduedSm,
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
    // gc-ol95: the Summary emails card always renders; its copy says honestly
    // whether sending is configured yet. `enabled` is what consent allows
    // (toggle on AND the merchant knows), so a shop never told reads "off".
    alerts: {
      configured: getMerchantAlertConfigStatus().configured,
      canReceive: canReceiveAlerts(shop.plan),
      cadence: features.alertCadence,
      enabled: summaryEffectivelyOn(shop),
      email: shop.alertEmail,
      // gc-2wnf: a plan with the speed report (Standard, Professional;
      // gc-d0ui) can also have its email report (and be sent for) a store
      // speed change, but only while the speed report is live.
      speedInSummary: isSpeedReportLive() && features.speedReport === true,
    },
    // Free speed test: the Free tile lists it while the speed report is live,
    // straight from the plan matrix (Free only since gc-d0ui).
    freeSpeedTestTiles: {
      free: isSpeedReportLive() && getPlanFeatures(PLANS.FREE).freeSpeedTest === true,
    },
    // The full speed report's bullet (gc-d0ui): Standard monthly, Professional
    // weekly, from the plan matrix, while the speed report is live.
    speedReportTiles: {
      standard:
        isSpeedReportLive() && getPlanFeatures(PLANS.STANDARD).speedReportCadence === "monthly",
      professional:
        isSpeedReportLive() && getPlanFeatures(PLANS.PROFESSIONAL).speedReportCadence === "weekly",
    },
  };
};

// ---------------------------------------------------------------------------
// Action (gc-syz.6, gc-ol95): summary-emails toggle
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent !== "set-alerts-enabled") {
    return { error: "Unknown request." };
  }

  const value = formData.get("enabled");
  if (value !== "true" && value !== "false") {
    return { error: "Invalid value." };
  }

  // Session shop only: the form never carries a shop id.
  const shop = await getShopMetadata(session.shop);
  if (!shop) {
    return { error: "Shop not found. Please reinstall the app." };
  }
  if (!canReceiveAlerts(shop.plan)) {
    return { error: SUMMARY_NOT_IN_PLAN };
  }

  // Turning it on while sending is live is the merchant's own opt-in (gc-ol95).
  // While dark it is not consent: they must see Home's notice first (Q9=9A).
  await setSummaryEmailsEnabled(shop.id, value === "true", {
    sendingLive: getMerchantAlertConfigStatus().configured,
    noticeShown: shop.summaryNoticeShownAt !== null,
  });
  return { alertsEnabled: value === "true" };
};

// ---------------------------------------------------------------------------
// Page sections (gc-4wvb): an h2 section header above a white section card
// ---------------------------------------------------------------------------

const h2Style: React.CSSProperties = { ...sectionHeader, marginTop: 0 };
const cardStyle: React.CSSProperties = { ...sectionCard, marginBottom: 0 };
const subdued: React.CSSProperties = { ...textSubdued, margin: 0, lineHeight: 1.45 };

// ---------------------------------------------------------------------------
// Summary emails card (gc-syz.6, copy per gc-ol95)
// ---------------------------------------------------------------------------

function SummaryEmailsCard({
  alerts,
  pricingPlansUrl,
  trialEligible,
}: {
  alerts: {
    configured: boolean;
    canReceive: boolean;
    cadence: string;
    enabled: boolean;
    email: string | null;
    speedInSummary: boolean;
  };
  pricingPlansUrl: string;
  trialEligible: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const saving = fetcher.state !== "idle";
  // Optimistic: show what was just submitted until the loader revalidates.
  const checked = fetcher.formData ? fetcher.formData.get("enabled") === "true" : alerts.enabled;
  const cadence = alerts.cadence === "weekly" ? "weekly" : "monthly";

  return (
    <section>
      <h2 style={h2Style}>{SUMMARY_CARD_HEADING}</h2>
      <div style={cardStyle}>
        <s-stack direction="block" gap="base">
          {alerts.canReceive ? (
            <>
              <s-checkbox
                label={summaryToggleLabel(cadence)}
                checked={checked ? true : undefined}
                disabled={saving ? true : undefined}
                onChange={(e: unknown) =>
                  fetcher.submit(
                    { intent: "set-alerts-enabled", enabled: String(readChecked(e)) },
                    { method: "POST" },
                  )
                }
              />
              <p style={subdued}>
                {alerts.configured
                  ? summaryLiveParagraph(alerts.email, alerts.speedInSummary)
                  : SUMMARY_COMING_SOON}
              </p>
              {fetcher.data && "error" in fetcher.data && (
                <s-banner tone="critical">{fetcher.data.error}</s-banner>
              )}
              {fetcher.data && "alertsEnabled" in fetcher.data && fetcher.state === "idle" && (
                <s-banner tone="success">
                  {!fetcher.data.alertsEnabled
                    ? SUMMARY_SAVED_OFF
                    : alerts.configured
                      ? SUMMARY_SAVED_ON
                      : SUMMARY_SAVED_ON_DARK}
                </s-banner>
              )}
            </>
          ) : (
            <>
              <p style={subdued}>{SUMMARY_FREE_PARAGRAPH}</p>
              <div>
                <a href={pricingPlansUrl} target="_top" rel="noreferrer">
                  <s-button variant="primary">
                    {upgradeCtaLabel(PLANS.STANDARD, trialEligible)}
                  </s-button>
                </a>
              </div>
            </>
          )}
        </s-stack>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Permissions card (client-side, all plans; gc-4n0y)
// ---------------------------------------------------------------------------

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

/** Zebra striping: every even row (1-based) gets the stripe background. */
function rowCell(index: number, extra?: React.CSSProperties): React.CSSProperties {
  return {
    ...styles.tableCell,
    padding: "10px 12px",
    ...(index % 2 === 1 ? { backgroundColor: TABLE_BG_STRIPE } : {}),
    ...extra,
  };
}

/**
 * Live granted-scope state for the optional per-audit scopes, with a re-consent
 * button that opens the App Bridge permission modal for only the missing scopes
 * (useOptionalScopes, shared with Home's welcome card). Rendered on every plan
 * (gc-4n0y): the checks these scopes unlock run on Free scans too. The one
 * exception is Broken links, which is a Standard feature by plan, not by
 * permission, so a plan without it says so instead of implying a grant adds it.
 */
export function PermissionsCard({ brokenLinksIncluded }: { brokenLinksIncluded: boolean }) {
  const { granted, unsupported, failed, requesting, missing, requestMissing } = useOptionalScopes();
  const allGranted = granted !== null && allOptionalScopesGranted(granted);

  return (
    <section>
      <h2 style={h2Style}>Permissions</h2>
      <div style={cardStyle}>
        <s-stack direction="block" gap="base">
          <p style={subdued}>
            Some checks need extra read-only access. GhostCode never changes your store.
          </p>
          {!brokenLinksIncluded && <p style={subdued}>{BROKEN_LINKS_STANDARD_NOTE}</p>}

          {unsupported ? (
            <p style={subdued}>
              Permission status is unavailable in this view. Reload the app from your Shopify admin
              to manage permissions.
            </p>
          ) : granted === null && !failed ? (
            <p style={subdued}>Checking permissions…</p>
          ) : (
            <>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th scope="col" style={styles.tableHeader}>
                      Permission and what it checks
                    </th>
                    <th scope="col" style={{ ...styles.tableHeader, ...statusColumn }}>
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {OPTIONAL_SCOPES.map((scope, i) => {
                    // When the query failed (granted === null) this renders a
                    // neutral "Status unavailable" badge instead of a false
                    // "Not granted": we couldn't read the real grant state.
                    const badge = scopeBadge(granted, scope);
                    return (
                      <tr key={scope}>
                        <td style={rowCell(i, { overflowWrap: "anywhere" })}>
                          <div style={{ fontWeight: 600, color: TEXT_PRIMARY }}>
                            {OPTIONAL_SCOPE_INFO[scope].label}
                          </div>
                          <div style={{ ...textSubduedSm, marginTop: "2px" }}>
                            {optionalScopeUnlocks(scope, brokenLinksIncluded)}
                          </div>
                        </td>
                        <td style={rowCell(i, statusColumn)}>
                          <s-badge tone={badge.tone}>{badge.text}</s-badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {allGranted ? (
                <p style={{ ...subdued, color: SUCCESS_TEXT_STRONG }}>
                  <span aria-hidden="true">✓</span> All granted. These checks run on every scan.
                </p>
              ) : (
                <div style={permissionsFooter}>
                  {granted !== null && (
                    <p style={subdued}>
                      {`${missing.length} of ${OPTIONAL_SCOPES.length} not granted. Those checks are skipped on your scans.`}
                    </p>
                  )}
                  <s-button
                    variant="primary"
                    onClick={requestMissing}
                    disabled={requesting ? true : undefined}
                  >
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
      </div>
    </section>
  );
}

/**
 * Status column: left-aligned, at least 120px, never truncating "Status
 * unavailable". Header and cells share it. Left, not right: an s-badge does not
 * follow its cell's text-align, so a right-aligned header sat 120px away from
 * left-sitting badges.
 */
const statusColumn: React.CSSProperties = {
  textAlign: "left",
  width: "120px",
  whiteSpace: "nowrap",
};

const permissionsFooter: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "16px",
  flexWrap: "wrap",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Settings() {
  const {
    shop,
    features,
    pricingPlansUrl,
    trialEligible,
    alerts,
    freeSpeedTestTiles,
    speedReportTiles,
  } = useLoaderData<typeof loader>();

  // An unrecognised stored plan gates like Free, so the Free tile is current.
  const currentPlan = TILE_PLANS.find((p) => p === shop.plan) ?? PLANS.FREE;

  // Each tile's speed bullet shows only while that plan's speed feature is live.
  const speedLive = {
    [PLANS.FREE]: freeSpeedTestTiles.free,
    [PLANS.STANDARD]: speedReportTiles.standard,
    [PLANS.PROFESSIONAL]: speedReportTiles.professional,
  };

  return (
    <s-page heading="Settings">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>
      <div style={hairline} />
      <div style={{ ...groundStyle, gap: "28px" }}>
        <section>
          <h2 style={h2Style}>Plan</h2>
          <div style={planGrid}>
            {TILE_PLANS.map((plan) => {
              const current = currentPlan === plan;
              const cta = planTileCta(plan, shop.plan, (target) =>
                upgradeCtaLabel(target, trialEligible),
              );
              return (
                <PlanTile
                  key={plan}
                  name={PLAN_TILE_META[plan].name}
                  price={PLAN_TILE_META[plan].price}
                  features={planTileBullets(plan, { speedLive: speedLive[plan], trialEligible })}
                  current={current}
                  badge={current ? "Current plan" : undefined}
                  cta={cta ? { ...cta, url: pricingPlansUrl } : undefined}
                />
              );
            })}
          </div>
          <p style={{ ...textSubduedSm, margin: "12px 2px 0" }}>
            Plan changes and cancellations happen on Shopify&apos;s pricing page, and GhostCode is
            billed on your Shopify invoice.
          </p>
        </section>

        <SummaryEmailsCard
          alerts={alerts}
          pricingPlansUrl={pricingPlansUrl}
          trialEligible={trialEligible}
        />

        {/* Permissions, every plan (gc-4n0y): the checks these scopes unlock run on
          Free scans too; Broken links stays a Standard feature by plan. */}
        <PermissionsCard brokenLinksIncluded={features.canDetectDanglingReferences} />

        <p style={{ ...textSubduedSm, margin: 0, textAlign: "center" }}>GhostCode 1.0.0</p>
      </div>
    </s-page>
  );
}

const planGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "16px",
};

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
