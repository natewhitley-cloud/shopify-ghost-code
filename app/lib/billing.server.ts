// Import PLANS for local use and re-export for existing server imports.
import { PLANS } from "./plans";
export { PLANS };

// Feature flags per plan. Used to gate UI and service-layer behavior.
export type PlanFeatures = {
  maxScansPerMonth: number;
  showFindingDetails: boolean;
  maxThemes: number;
  autoRescan: boolean;
  scanDiffing: boolean;
  /** Whether the plan receives any form of scheduled (automatic) scanning. */
  scheduledScan: boolean;
  // Manual feature flag — set to true to enable Permission Audit tab
  permissionAuditEnabled: boolean;
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
        permissionAuditEnabled: false,
      };
    case PLANS.PROFESSIONAL:
      return {
        maxScansPerMonth: Infinity,
        showFindingDetails: true,
        maxThemes: Infinity,
        autoRescan: true,
        scanDiffing: true,
        scheduledScan: true, // Daily via poll-theme-changes coordinator
        permissionAuditEnabled: false,
      };
    default: // FREE — no active Shopify subscription
      return {
        maxScansPerMonth: 1,
        showFindingDetails: false,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: false,
        permissionAuditEnabled: false,
      };
  }
}
