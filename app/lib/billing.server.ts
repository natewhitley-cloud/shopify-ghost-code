// Plan name constants — kept in sync with billing config keys in shopify.server.ts.
// Use PLANS.STANDARD and PLANS.PROFESSIONAL when calling billing.require() or billing.request().
// The FREE constant is a sentinel value; no corresponding Shopify subscription plan exists.
export const PLANS = {
  FREE: "free",
  STANDARD: "Standard",
  PROFESSIONAL: "Professional",
} as const;

type PlanName = (typeof PLANS)[keyof typeof PLANS];

// Feature flags per plan. Used to gate UI and service-layer behavior.
type PlanFeatures = {
  maxScansPerMonth: number;
  showFindingDetails: boolean;
  maxThemes: number;
  autoRescan: boolean;
  scanDiffing: boolean;
  /** Whether the plan receives any form of scheduled (automatic) scanning. */
  scheduledScan: boolean;
};

export function getPlanFeatures(planName: string): PlanFeatures {
  switch (planName) {
    case PLANS.STANDARD:
      return {
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true, // Weekly (Sunday 6 AM UTC) via weekly-scan coordinator
      };
    case PLANS.PROFESSIONAL:
      return {
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: Infinity,
        autoRescan: true,
        scanDiffing: true,
        scheduledScan: true, // Daily via poll-theme-changes coordinator
      };
    default: // FREE — no active Shopify subscription
      return {
        maxScansPerMonth: 1,
        showFindingDetails: false,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: false,
      };
  }
}
