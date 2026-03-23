/**
 * Generate specific privacy/security alerts for apps with sensitive scopes.
 * Supplements the numeric risk score with human-readable PII warnings.
 */

/** Scopes that grant access to customer PII */
const PII_SCOPES = new Set([
  "read_customers",
  "write_customers",
  "read_customer_payment_methods",
  "read_all_orders",
  "read_orders",
  "write_orders",
]);

/** Scopes that can modify store behavior */
const STORE_MODIFICATION_SCOPES = new Set([
  "write_checkouts",
  "write_products",
  "write_themes",
  "write_script_tags",
  "write_price_rules",
]);

export type SensitiveAlert = {
  scope: string;
  category: "pii" | "store-modification";
  message: string;
};

/**
 * Generate alerts for an app based on its granted scopes.
 * Returns an array of alerts, one per sensitive scope found.
 */
export function generateSensitiveAlerts(grantedScopes: string[]): SensitiveAlert[] {
  const alerts: SensitiveAlert[] = [];

  for (const scope of grantedScopes) {
    if (PII_SCOPES.has(scope)) {
      alerts.push({
        scope,
        category: "pii",
        message: getPiiMessage(scope),
      });
    }
    if (STORE_MODIFICATION_SCOPES.has(scope)) {
      alerts.push({
        scope,
        category: "store-modification",
        message: getModificationMessage(scope),
      });
    }
  }

  return alerts;
}

function getPiiMessage(scope: string): string {
  switch (scope) {
    case "read_customers":
      return "Can read all customer names, emails, addresses, and phone numbers";
    case "write_customers":
      return "Can read AND modify all customer data including personal information";
    case "read_customer_payment_methods":
      return "Can access stored payment method details";
    case "read_all_orders":
      return "Can read every order ever placed, including customer details and payment info";
    case "read_orders":
      return "Can read recent orders including customer details";
    case "write_orders":
      return "Can read AND modify orders including customer-facing information";
    default:
      return `Has access to sensitive data via ${scope}`;
  }
}

function getModificationMessage(scope: string): string {
  switch (scope) {
    case "write_checkouts":
      return "Can modify checkout behavior — could affect payment flow";
    case "write_products":
      return "Can modify product listings, prices, and availability";
    case "write_themes":
      return "Can modify your store's theme code directly";
    case "write_script_tags":
      return "Can inject JavaScript into your storefront";
    case "write_price_rules":
      return "Can create or modify discount rules and pricing";
    default:
      return `Can modify store via ${scope}`;
  }
}

/**
 * Check if any granted scopes are PII-sensitive.
 */
export function hasPiiAccess(grantedScopes: string[]): boolean {
  return grantedScopes.some((s) => PII_SCOPES.has(s));
}
