import { describe, it, expect, vi } from "vitest";

import {
  isAccessDeniedError,
  probeScope,
  TransientScopeCheckError,
} from "../../app/lib/scope-check.server";
import type { AdminApiContext } from "../../app/types/shopify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdmin(graphqlMock: ReturnType<typeof vi.fn>): AdminApiContext {
  return { graphql: graphqlMock } as unknown as AdminApiContext;
}

/** Build an admin whose graphql() resolves to a response with the given json body. */
function adminWithJson(body: unknown): AdminApiContext {
  return makeAdmin(vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue(body) }));
}

const PROBE = `{ products(first: 1) { nodes { id } } }`;
const LABEL = "read_products";

// ---------------------------------------------------------------------------
// isAccessDeniedError
// ---------------------------------------------------------------------------

describe("isAccessDeniedError", () => {
  it("matches an explicit ACCESS_DENIED extensions code (any casing)", () => {
    expect(isAccessDeniedError({ message: "nope", extensions: { code: "ACCESS_DENIED" } })).toBe(
      true,
    );
    expect(isAccessDeniedError({ message: "nope", extensions: { code: "access_denied" } })).toBe(
      true,
    );
  });

  it("matches a human access-denied message with no code", () => {
    expect(isAccessDeniedError({ message: "Access denied for products field" })).toBe(true);
    expect(
      isAccessDeniedError({ message: "This app is not approved to access the Page object" }),
    ).toBe(true);
  });

  it("does NOT match throttling or generic errors", () => {
    expect(isAccessDeniedError({ message: "Throttled", extensions: { code: "THROTTLED" } })).toBe(
      false,
    );
    expect(isAccessDeniedError({ message: "Internal server error" })).toBe(false);
    expect(isAccessDeniedError({ message: "" })).toBe(false);
    expect(isAccessDeniedError({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeScope
// ---------------------------------------------------------------------------

describe("probeScope", () => {
  it("returns true when the probe has no errors", async () => {
    const admin = adminWithJson({ data: { products: { nodes: [] } } });
    expect(await probeScope(admin, PROBE, LABEL)).toBe(true);
  });

  it("returns false on a genuine ACCESS_DENIED (scope not granted)", async () => {
    const admin = adminWithJson({ errors: [{ message: "Access denied" }], data: null });
    expect(await probeScope(admin, PROBE, LABEL)).toBe(false);
  });

  it("returns false when access-denied is mixed with a transient error", async () => {
    // If the scope is genuinely denied, that takes precedence regardless of
    // any accompanying transient error — the audit should be skipped cleanly.
    const admin = adminWithJson({
      errors: [
        { message: "Throttled", extensions: { code: "THROTTLED" } },
        { message: "Access denied", extensions: { code: "ACCESS_DENIED" } },
      ],
      data: null,
    });
    expect(await probeScope(admin, PROBE, LABEL)).toBe(false);
  });

  it("throws TransientScopeCheckError when graphql() rejects (network/timeout)", async () => {
    const admin = makeAdmin(vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(probeScope(admin, PROBE, LABEL)).rejects.toBeInstanceOf(TransientScopeCheckError);
    await expect(probeScope(admin, PROBE, LABEL)).rejects.toThrow(/read_products/);
  });

  it("throws TransientScopeCheckError on THROTTLED (not access-denied)", async () => {
    const admin = adminWithJson({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      data: null,
    });
    await expect(probeScope(admin, PROBE, LABEL)).rejects.toBeInstanceOf(TransientScopeCheckError);
  });

  it("throws TransientScopeCheckError on an unexpected GraphQL error", async () => {
    const admin = adminWithJson({ errors: [{ message: "Internal server error" }], data: null });
    await expect(probeScope(admin, PROBE, LABEL)).rejects.toBeInstanceOf(TransientScopeCheckError);
  });

  it("preserves the original error as `cause`", async () => {
    const original = new Error("socket hang up");
    const admin = makeAdmin(vi.fn().mockRejectedValue(original));
    await expect(probeScope(admin, PROBE, LABEL)).rejects.toMatchObject({ cause: original });
  });
});
