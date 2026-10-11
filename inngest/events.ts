/**
 * Inngest event type definitions for Ghost Code.
 *
 * Add new event types here as the feature set grows. Each key is the event
 * name used when calling `inngest.send()`. The `data` shape is validated at
 * the TypeScript level — keep it minimal and explicit.
 */
export type Events = {
  /** Triggered when a merchant requests a new theme scan. */
  "scan/requested": {
    data: {
      shopId: string;
      themeId: string;
      scanId: string;
    };
  };

  /**
   * Emitted by the plan-cadence coordinators (weekly-scan: Professional,
   * monthly-scan: Standard) for each shop. The poll-check-shop worker starts a
   * SCHEDULED scan per event, with a concurrency limit to avoid overwhelming
   * the Shopify API.
   */
  "poll/check-shop": {
    data: {
      shopId: string;
      shopDomain: string;
    };
  };

  /**
   * One store speed report run (gc-wt3y). Sent by the speed-report-weekly
   * coordinator (SCHEDULED, no reportId: the worker creates the row) and by the
   * Store speed page's "Run speed test now" (MANUAL, with the RUNNING row the
   * action already created).
   */
  "speed-report/requested": {
    data: {
      shopId: string;
      origin: "SCHEDULED" | "MANUAL";
      reportId?: string;
    };
  };
};
