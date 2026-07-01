// Plan name constants — shared between server and client code.
// Kept in sync with billing config keys in shopify.server.ts.
// The FREE constant is a sentinel value; no corresponding Shopify subscription plan exists.
export const PLANS = {
  FREE: "free",
  STANDARD: "Standard",
  PROFESSIONAL: "Professional",
} as const;

// App handle from the Shopify Partner Dashboard (Apps → Ghost Code).
// Used to build the Managed Pricing "Select a plan" URL. This is the app's
// URL slug (`ghost-code`) — NOT the client_id.
export const APP_HANDLE = "ghost-code";
