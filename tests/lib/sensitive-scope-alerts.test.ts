import { describe, it, expect } from "vitest";

import { generateSensitiveAlerts, hasPiiAccess } from "../../app/lib/sensitive-scope-alerts.server";

describe("generateSensitiveAlerts", () => {
  it("returns PII alerts for customer-related scopes", () => {
    const alerts = generateSensitiveAlerts(["read_customers", "read_themes"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe("pii");
    expect(alerts[0].scope).toBe("read_customers");
  });

  it("returns store-modification alerts for write scopes", () => {
    const alerts = generateSensitiveAlerts(["write_checkouts", "read_products"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe("store-modification");
    expect(alerts[0].scope).toBe("write_checkouts");
  });

  it("returns both PII and modification alerts", () => {
    const alerts = generateSensitiveAlerts(["read_customers", "write_themes"]);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.category)).toContain("pii");
    expect(alerts.map((a) => a.category)).toContain("store-modification");
  });

  it("returns empty array for non-sensitive scopes", () => {
    const alerts = generateSensitiveAlerts(["read_products", "read_themes", "read_content"]);
    expect(alerts).toHaveLength(0);
  });

  it("returns empty array for empty scopes", () => {
    const alerts = generateSensitiveAlerts([]);
    expect(alerts).toHaveLength(0);
  });

  it("generates correct messages for each PII scope", () => {
    const piiScopes = [
      "read_customers",
      "write_customers",
      "read_customer_payment_methods",
      "read_all_orders",
      "read_orders",
      "write_orders",
    ];
    const alerts = generateSensitiveAlerts(piiScopes);
    expect(alerts.filter((a) => a.category === "pii")).toHaveLength(piiScopes.length);
    // Each alert should have a non-empty message
    for (const alert of alerts) {
      expect(alert.message.length).toBeGreaterThan(0);
    }
  });

  it("generates correct messages for each store-modification scope", () => {
    const modScopes = [
      "write_checkouts",
      "write_products",
      "write_themes",
      "write_script_tags",
      "write_price_rules",
    ];
    const alerts = generateSensitiveAlerts(modScopes);
    expect(alerts.filter((a) => a.category === "store-modification")).toHaveLength(
      modScopes.length,
    );
    for (const alert of alerts) {
      expect(alert.message.length).toBeGreaterThan(0);
    }
  });

  it("classifies write_orders as both PII (not store-modification)", () => {
    const alerts = generateSensitiveAlerts(["write_orders"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe("pii");
  });
});

describe("hasPiiAccess", () => {
  it("returns true when scopes include read_customers", () => {
    expect(hasPiiAccess(["read_products", "read_customers"])).toBe(true);
  });

  it("returns true when scopes include read_all_orders", () => {
    expect(hasPiiAccess(["read_all_orders"])).toBe(true);
  });

  it("returns false when no PII scopes present", () => {
    expect(hasPiiAccess(["read_products", "read_themes"])).toBe(false);
  });

  it("returns false for empty scopes", () => {
    expect(hasPiiAccess([])).toBe(false);
  });

  it("returns true for write_customers", () => {
    expect(hasPiiAccess(["write_customers"])).toBe(true);
  });

  it("returns true for read_customer_payment_methods", () => {
    expect(hasPiiAccess(["read_customer_payment_methods"])).toBe(true);
  });
});
