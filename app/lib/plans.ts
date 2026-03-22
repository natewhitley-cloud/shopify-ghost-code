// Plan name constants — shared between server and client code.
// Kept in sync with billing config keys in shopify.server.ts.
// The FREE constant is a sentinel value; no corresponding Shopify subscription plan exists.
export const PLANS = {
  FREE: "free",
  STANDARD: "Standard",
  PROFESSIONAL: "Professional",
} as const;
