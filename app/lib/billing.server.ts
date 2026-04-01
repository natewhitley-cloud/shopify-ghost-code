// Import PLANS for local use and re-export for existing server imports.
import { PLANS } from "./plans";
export { PLANS };

// Feature flags per plan. Used to gate UI and service-layer behavior.
export type PlanFeatures = {
  maxScansPerMonth: number;
  maxScansPerWeek: number;
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
        maxScansPerWeek: 1,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: false, // Manual weekly scans only — automation is Professional
      };
    case PLANS.PROFESSIONAL:
      return {
        maxScansPerMonth: Infinity,
        maxScansPerWeek: Infinity,
        showFindingDetails: true,
        maxThemes: Infinity,
        autoRescan: true,
        scanDiffing: true,
        scheduledScan: true, // Daily via poll-theme-changes coordinator
      };
    default: // FREE — no active Shopify subscription
      return {
        maxScansPerMonth: 1,
        // Infinity signals "no weekly cap" — getScanUsage skips the weekly
        // check and falls through to the monthly limit instead.
        maxScansPerWeek: Infinity,
        showFindingDetails: false,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: false,
      };
  }
}
