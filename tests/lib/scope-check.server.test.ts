import { describe, it, expect, vi } from "vitest";

import { logger } from "../../app/lib/logger.server";
import { OPTIONAL_SCOPES, type OptionalScope } from "../../app/lib/optional-scopes";
import {
  checkOptionalScope,
  fetchGrantedOptionalScopes,
  type GrantedOptionalScopes,
  grantedOptionalScopesFrom,
  isAccessDeniedError,
  probeScope,
  TransientScopeCheckError,
} from "../../app/lib/scope-check.server";
import { hasContentScope } from "../../app/services/content-fetcher.server";
import { hasProductScope } from "../../app/services/product-fetcher.server";
import { hasNavigationScope } from "../../app/services/redirect-fetcher.server";
import { hasTranslationScope } from "../../app/services/translation-fetcher.server";
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

/**
 * Build an admin whose graphql() THROWS a GraphqlQueryError-shaped error.
 *
 * Mirrors what @shopify/shopify-api's GraphqlClient.request() throws when the
 * API returns a 200 with GraphQL errors in the body: the error's top-level
 * .message is the first GQL error message, and .body.errors.graphQLErrors is
 * the raw array of GQL error objects ({message, extensions}).
 */
function adminWithThrownGraphqlError(
  message: string,
  graphqlErrors: Array<{ message: string; extensions?: { code?: string } }>,
): AdminApiContext {
  const err = Object.assign(new Error(message), {
    body: { errors: { graphQLErrors: graphqlErrors } },
  });
  return makeAdmin(vi.fn().mockRejectedValue(err));
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

  // ----- GC-jlk: thrown-error path (admin.graphql THROWS instead of returning body errors) -----

  it("returns false when graphql() throws a GraphqlQueryError with access-denied message (message-only path)", async () => {
    // Simulates the real prod failure: "Access denied for shopLocales field.
    // Required access: read_locales or read_markets_home"
    const admin = adminWithThrownGraphqlError(
      "Access denied for shopLocales field. Required access: read_locales or read_markets_home",
      [
        {
          message:
            "Access denied for shopLocales field. Required access: read_locales or read_markets_home",
        },
      ],
    );
    expect(await probeScope(admin, PROBE, LABEL)).toBe(false);
  });

  it("returns false when graphql() throws a GraphqlQueryError with ACCESS_DENIED extensions code (structured path)", async () => {
    // Simulates an access-denied with a machine-readable extensions.code —
    // caught via body.errors.graphQLErrors on the thrown error.
    const admin = adminWithThrownGraphqlError("Access denied for products field", [
      { message: "Access denied for products field", extensions: { code: "ACCESS_DENIED" } },
    ]);
    expect(await probeScope(admin, PROBE, LABEL)).toBe(false);
  });

  it("throws TransientScopeCheckError when graphql() throws a genuinely transient error (no access-denied markers)", async () => {
    // Simulates a thrown error with no access-denied signal: must stay transient.
    const admin = adminWithThrownGraphqlError("Network timeout", [
      { message: "Network timeout", extensions: { code: "THROTTLED" } },
    ]);
    await expect(probeScope(admin, PROBE, LABEL)).rejects.toBeInstanceOf(TransientScopeCheckError);
  });

  it("throws TransientScopeCheckError when graphql() throws a plain Error with no access-denied markers", async () => {
    const admin = makeAdmin(vi.fn().mockRejectedValue(new Error("Internal server error")));
    await expect(probeScope(admin, PROBE, LABEL)).rejects.toBeInstanceOf(TransientScopeCheckError);
  });
});

// ---------------------------------------------------------------------------
// Granted-scope pre-check (gc-5l9)
// ---------------------------------------------------------------------------

describe("grantedOptionalScopesFrom", () => {
  it("keeps only optional scopes, in declared order, ignoring required/unknown handles", () => {
    expect(
      grantedOptionalScopesFrom(["read_online_store_navigation", "read_themes", "read_products"]),
    ).toEqual(["read_products", "read_online_store_navigation"]);
  });

  it("returns [] when no optional scope is granted", () => {
    expect(grantedOptionalScopesFrom([])).toEqual([]);
    expect(grantedOptionalScopesFrom(["read_themes"])).toEqual([]);
  });

  it("counts a write_ grant as its read_ scope (write implies read)", () => {
    expect(grantedOptionalScopesFrom(["write_content", "write_translations"])).toEqual([
      "read_translations",
      "read_content",
    ]);
  });

  it("does not treat a read_ grant as unlocking anything beyond itself", () => {
    expect(grantedOptionalScopesFrom(["read_product_listings"])).toEqual([]);
  });
});

describe("fetchGrantedOptionalScopes", () => {
  function accessScopesBody(handles: unknown[]) {
    return {
      data: { currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) } },
    };
  }

  it("makes ONE accessScopes query and returns the granted optional scopes", async () => {
    const graphql = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(accessScopesBody(["read_themes", "read_content"])),
    });

    expect(await fetchGrantedOptionalScopes(makeAdmin(graphql), "shop_1")).toEqual([
      "read_content",
    ]);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][0]).toContain("currentAppInstallation");
    expect(graphql.mock.calls[0][0]).toContain("accessScopes");
  });

  it("ignores non-string handles", async () => {
    const admin = adminWithJson(accessScopesBody([null, 42, "read_products"]));
    expect(await fetchGrantedOptionalScopes(admin, "shop_1")).toEqual(["read_products"]);
  });

  it.each([
    ["the client throws", makeAdmin(vi.fn().mockRejectedValue(new Error("network down")))],
    ["the body has GraphQL errors", adminWithJson({ errors: [{ message: "Throttled" }] })],
    ["data is missing", adminWithJson({})],
    ["currentAppInstallation is null", adminWithJson({ data: { currentAppInstallation: null } })],
    [
      "accessScopes is not a list",
      adminWithJson({ data: { currentAppInstallation: { accessScopes: "nope" } } }),
    ],
  ])("returns null (probe fallback) and logs a warning when %s", async (_label, admin) => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(await fetchGrantedOptionalScopes(admin, "shop_1")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("accessScopes lookup failed"),
      expect.objectContaining({ event: "access_scopes_lookup_failed", shopId: "shop_1" }),
    );
    warnSpy.mockRestore();
  });
});

describe("checkOptionalScope", () => {
  const OK = { json: vi.fn().mockResolvedValue({ data: {} }) };
  const DENIED = {
    json: vi.fn().mockResolvedValue({
      errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }],
    }),
  };

  it("returns false with NO query when the scope is not in the granted list", async () => {
    const graphql = vi.fn().mockResolvedValue(OK);
    expect(await checkOptionalScope(makeAdmin(graphql), "read_products", PROBE, [])).toBe(false);
    expect(
      await checkOptionalScope(makeAdmin(graphql), "read_products", PROBE, ["read_content"]),
    ).toBe(false);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("probes a granted scope and returns true when the probe succeeds", async () => {
    const graphql = vi.fn().mockResolvedValue(OK);
    expect(
      await checkOptionalScope(makeAdmin(graphql), "read_products", PROBE, ["read_products"]),
    ).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith(PROBE);
  });

  it("returns false when a granted scope's probe is ACCESS_DENIED (grant is not proof)", async () => {
    const graphql = vi.fn().mockResolvedValue(DENIED);
    expect(
      await checkOptionalScope(makeAdmin(graphql), "read_products", PROBE, ["read_products"]),
    ).toBe(false);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("propagates a transient probe error for a granted scope", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(
      checkOptionalScope(makeAdmin(graphql), "read_products", PROBE, ["read_products"]),
    ).rejects.toBeInstanceOf(TransientScopeCheckError);
  });

  it("always probes when the granted list is unknown (null)", async () => {
    const graphql = vi.fn().mockResolvedValue(DENIED);
    expect(await checkOptionalScope(makeAdmin(graphql), "read_products", PROBE, null)).toBe(false);
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});

// The four per-audit scope checks all route through checkOptionalScope; this
// table locks each one to ITS scope handle so a mis-wired handle (e.g. the
// redirect check keyed on read_content) cannot slip through.
describe("has*Scope wrappers (gc-5l9)", () => {
  const CHECKS: Array<
    [OptionalScope, (admin: AdminApiContext, granted: GrantedOptionalScopes) => Promise<boolean>]
  > = [
    ["read_translations", hasTranslationScope],
    ["read_products", hasProductScope],
    ["read_content", hasContentScope],
    ["read_online_store_navigation", hasNavigationScope],
  ];

  it("covers every optional scope", () => {
    expect(CHECKS.map(([scope]) => scope).sort()).toEqual([...OPTIONAL_SCOPES].sort());
  });

  it.each(CHECKS)("%s: none granted -> false with zero queries", async (_scope, check) => {
    const graphql = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ data: {} }) });
    expect(await check(makeAdmin(graphql), [])).toBe(false);
    expect(graphql).not.toHaveBeenCalled();
  });

  it.each(CHECKS)("%s: only its own grant triggers its probe", async (scope, check) => {
    const graphql = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ data: {} }) });
    const others = OPTIONAL_SCOPES.filter((s) => s !== scope);
    expect(await check(makeAdmin(graphql), others)).toBe(false);
    expect(graphql).not.toHaveBeenCalled();

    expect(await check(makeAdmin(graphql), [scope])).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it.each(CHECKS)("%s: null granted -> probes (pre-gc-5l9 behavior)", async (_scope, check) => {
    const graphql = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ data: {} }) });
    expect(await check(makeAdmin(graphql), null)).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
