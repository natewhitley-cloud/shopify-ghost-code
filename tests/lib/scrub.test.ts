import { describe, it, expect } from "vitest";

import { scrubContext, scrubStack, scrubString } from "../../app/lib/scrub";
// Ported with the scrub from FraudPilot (gc-t7o2); the audit labels are
// FraudPilot's ft-h6o pre-deploy fixes (M1, M2, L1, L2).

describe("nested URL secrets (audit M1)", () => {
  it("redacts Shopify's session-token bounce URL nested in shopify-reload", () => {
    const inner =
      "https://app.example.com/app?embedded=1&hmac=deadbeef&session=abc&id_token=eyJsecret&shop=s.myshopify.com";
    const url = `/auth/session-token?shop=s.myshopify.com&shopify-reload=${encodeURIComponent(inner)}`;
    const out = scrubString(url);
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("eyJsecret");
    expect(out).not.toContain("abc");
    expect(out).toBe("/auth/session-token?shop=s.myshopify.com&shopify-reload=[REDACTED]");
  });

  it("redacts an unencoded nested ?id_token inside a param value", () => {
    expect(scrubString("/x?redirect=/a?id_token=eyJsecret")).not.toContain("eyJsecret");
  });

  it("leaves a nested URL with nothing sensitive intact", () => {
    const url = `/x?return_to=${encodeURIComponent("/app/review-queue?page=2")}`;
    expect(scrubString(url)).toBe(url);
  });
});

describe("stack traces keep :line:col (audit M2)", () => {
  it("keeps each frame's line and column", () => {
    const stack = [
      "Error: boom",
      "    at fn (/app/build/server/index.js:1234:56)",
      "    at /app/node_modules/x/y.js:7:8",
    ].join("\n");
    expect(scrubStack(stack)).toBe(stack);
  });

  it("still scrubs PII inside a frame and in the message line", () => {
    const stack = [
      "Error: failed for buyer@example.com at 12:30:45",
      "    at fn (/app/203.0.113.7/index.js:10:2)",
    ].join("\n");
    const out = scrubStack(stack);
    expect(out).not.toContain("buyer@example.com");
    expect(out).not.toContain("203.0.113.7");
    expect(out).toContain("index.js:10:2)");
    // Outside a frame tail the broad IPv6 rule still applies (safe direction).
    expect(out).not.toContain("12:30:45");
  });
});

describe("long strings (audit L1)", () => {
  it("caps a 100 KB separator-free string before the regexes run", () => {
    const start = performance.now();
    const out = scrubString("a".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out.length).toBeLessThan(17_000);
    expect(out.endsWith("...[truncated]")).toBe(true);
  });

  it("leaves strings under the cap untouched in length", () => {
    expect(scrubString("x".repeat(1000))).toBe("x".repeat(1000));
  });
});

describe("Dates and Errors in meta (audit L2)", () => {
  it("serializes a Date as ISO and an Error as a scrubbed name/message", () => {
    const out = scrubContext({
      planVerifiedAt: new Date("2026-10-02T12:00:00Z"),
      bad: new Date("nope"),
      err: new TypeError("no row for buyer@example.com"),
    });
    expect(out).toEqual({
      planVerifiedAt: "2026-10-02T12:00:00.000Z",
      bad: "Invalid Date",
      err: { name: "TypeError", message: "no row for [REDACTED]" },
    });
  });
});

describe("operational keys skip only the key rule (gc-t7o2)", () => {
  it.each([
    ["skipped", 3],
    ["skippedFiles", ["sections/app-embed.liquid"]],
    ["skippedCategories", { vendor: 2 }],
    ["benignLibrarySkips", 4],
    ["unknownScriptCount", 1],
    ["activeSubscriptionCount", 1],
    ["hasRefreshToken", true],
    ["tokenExpired", false],
  ])("keeps %s intact", (key, value) => {
    expect(scrubContext({ [key]: value })[key]).toEqual(value);
  });

  it("still scrubs an operational key's value", () => {
    expect(
      scrubContext({ skippedFiles: ["from buyer@example.com at 203.0.113.7"] }).skippedFiles,
    ).toEqual(["from [REDACTED] at [REDACTED]"]);
  });

  it("still applies the key rule to keys nested under an operational key", () => {
    expect(
      scrubContext({ skippedCategories: { accessToken: "shpat_x", count: 2 } }).skippedCategories,
    ).toEqual({ accessToken: "[REDACTED]", count: 2 });
  });

  it("does not exempt a near-miss key", () => {
    expect(scrubContext({ skippedIp: "1.2.3.4", token: "t" })).toEqual({
      skippedIp: "[REDACTED]",
      token: "[REDACTED]",
    });
  });
});

describe("nested query-param recursion is bounded (ft-edm M1)", () => {
  it("does not overflow the stack on deeply nested params", () => {
    expect(() => scrubString("?x=" + "?a=".repeat(2000))).not.toThrow();
  });

  it("redacts a param nested past the depth cap (fail safe)", () => {
    expect(scrubString("/p?x=?a=?b=?c=?d=1")).toBe("/p?x=[REDACTED]");
  });

  it("still inspects a two-level nested URL", () => {
    expect(
      scrubString(
        "/app?shopify-reload=" + encodeURIComponent("/app?next=" + encodeURIComponent("/x?ok=1")),
      ),
    ).toContain("shopify-reload=%2Fapp");
  });
});
