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
   * Emitted by the poll-theme-changes coordinator for each Professional-plan
   * shop. The poll-check-shop worker function processes these events with a
   * concurrency limit to avoid overwhelming the Shopify API.
   */
  "poll/check-shop": {
    data: {
      shopId: string;
      shopDomain: string;
    };
  };
};
