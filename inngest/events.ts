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
  /** Triggered when Shopify emits a theme_updated webhook for a shop. */
  "theme/changed": {
    data: {
      shopId: string;
      themeId: string;
    };
  };
};
