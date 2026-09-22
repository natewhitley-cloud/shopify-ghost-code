/**
 * Tests for inngest/functions/reconcile-installs.ts (gc-dyt).
 *
 * This job can churn a LIVE PAYING merchant if it marks a shop uninstalled on a
 * non-definitive error, so the safety cases (THROTTLED / network / 5xx / no
 * session → NEVER marked) are the most important tests here.
 *
 * Strategy:
 *   - Mock the Inngest client (3-arg createFunction) + ops-event.server so the
 *     module (and its withCronHeartbeat wrapper) loads without a DB.
 *   - Unit-test the pure classifiers (extractHttpStatus, isDefinitiveAuthFailure,
 *     classifyResponseStatus).
 *   - Drive the handler through the mock step (createMockInngestStep executes
 *     each step callback immediately; step.sleep is a no-op) with mocked
 *     unauthenticated.admin / admin.graphql / markShopUninstalledWithEvent /
 *     recordOpsEvent, and assert exactly which shops are marked.
 */

import { HttpResponseError, InvalidJwtError } from "@shopify/shopify-api";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

vi.mock("../../app/models/ops-event.server", () => ({
  // recordCronHeartbeat backs the real withCronHeartbeat wrapper at module load.
  recordCronHeartbeat: vi.fn(),
  recordOpsEvent: vi.fn(),
  OPS_EVENT_TYPES: {
    SHOP_UNINSTALLED: "shop_uninstalled",
    RECONCILE_SUMMARY: "reconcile_summary",
  },
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({
  default: { shop: { findMany: vi.fn() } },
}));

vi.mock("../../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
}));

vi.mock("../../app/models/shop.server", () => ({
  markShopUninstalledWithEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { recordOpsEvent } from "../../app/models/ops-event.server";
import { markShopUninstalledWithEvent } from "../../app/models/shop.server";
import { unauthenticated } from "../../app/shopify.server";
import {
  classifyResponseStatus,
  extractHttpStatus,
  isDefinitiveAuthFailure,
  isRefreshTokenRejected,
  reconcileInstalls,
} from "../../inngest/functions/reconcile-installs";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockFindMany = (db as unknown as { shop: { findMany: ReturnType<typeof vi.fn> } }).shop
  .findMany;
const mockAdmin = (unauthenticated as unknown as { admin: ReturnType<typeof vi.fn> }).admin;
const mockMark = markShopUninstalledWithEvent as ReturnType<typeof vi.fn>;
const mockRecordOpsEvent = recordOpsEvent as ReturnType<typeof vi.fn>;

/** An unauthenticated.admin resolution whose graphql behaves as configured. */
function adminGraphql(behavior: () => Promise<{ status?: number }>) {
  return { admin: { graphql: vi.fn(behavior) } };
}

async function runReconcile() {
  const step = createMockInngestStep();
  return getInngestHandler(reconcileInstalls)({ step });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMark.mockResolvedValue({ newlyMarked: true, found: true });
  mockRecordOpsEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

describe("extractHttpStatus", () => {
  it("reads HttpResponseError-style response.code", () => {
    expect(extractHttpStatus({ response: { code: 401 } })).toBe(401);
    expect(extractHttpStatus({ response: { code: 429 } })).toBe(429);
  });

  it("reads status / statusCode fallbacks", () => {
    expect(extractHttpStatus({ status: 500 })).toBe(500);
    expect(extractHttpStatus({ statusCode: 503 })).toBe(503);
  });

  it("returns null when no numeric status is present", () => {
    expect(extractHttpStatus(new Error("fetch failed"))).toBeNull();
    expect(extractHttpStatus(null)).toBeNull();
    expect(extractHttpStatus("boom")).toBeNull();
    expect(extractHttpStatus({ response: { code: "401" } })).toBeNull();
  });
});

describe("isDefinitiveAuthFailure", () => {
  it("is TRUE for an HTTP 401 (revoked token)", () => {
    expect(isDefinitiveAuthFailure({ response: { code: 401, statusText: "Unauthorized" } })).toBe(
      true,
    );
    expect(isDefinitiveAuthFailure({ status: 401 })).toBe(true);
  });

  it("is TRUE for the classic invalid/revoked-token message (no structured status)", () => {
    expect(
      isDefinitiveAuthFailure(
        new Error("[API] Invalid API key or access token (unrecognized login or wrong password)"),
      ),
    ).toBe(true);
    expect(
      isDefinitiveAuthFailure(
        new Error("Received an error response (401 Unauthorized) from Shopify"),
      ),
    ).toBe(true);
  });

  it("is FALSE for THROTTLED / 429 (the critical safety case)", () => {
    expect(isDefinitiveAuthFailure({ response: { code: 429 } })).toBe(false);
    expect(isDefinitiveAuthFailure(new Error("Throttled"))).toBe(false);
    expect(
      isDefinitiveAuthFailure({
        body: { errors: { graphQLErrors: [{ extensions: { code: "THROTTLED" } }] } },
        message: "GraphQL query returned errors",
      }),
    ).toBe(false);
  });

  it("is FALSE for network / timeout / 5xx / unexpected errors", () => {
    expect(isDefinitiveAuthFailure(new Error("network timeout ETIMEDOUT"))).toBe(false);
    expect(isDefinitiveAuthFailure(new Error("fetch failed"))).toBe(false);
    expect(isDefinitiveAuthFailure({ response: { code: 500 } })).toBe(false);
    expect(isDefinitiveAuthFailure({ response: { code: 503 } })).toBe(false);
    expect(isDefinitiveAuthFailure(null)).toBe(false);
    expect(isDefinitiveAuthFailure(undefined)).toBe(false);
    expect(isDefinitiveAuthFailure("some string")).toBe(false);
  });
});

describe("isRefreshTokenRejected", () => {
  it("is TRUE for an InvalidJwtError (offline-token refresh rejected)", () => {
    expect(isRefreshTokenRejected(new InvalidJwtError("invalid jwt"))).toBe(true);
  });

  it("is TRUE for an HttpResponseError 400 with body.error === 'invalid_subject_token'", () => {
    expect(
      isRefreshTokenRejected(
        new HttpResponseError({
          message: "Bad Request",
          statusText: "Bad Request",
          code: 400,
          body: { error: "invalid_subject_token" },
        }),
      ),
    ).toBe(true);
  });

  it("is FALSE for the library's transient new Response(500) refresh wrapper", () => {
    expect(isRefreshTokenRejected(new Response(undefined, { status: 500 }))).toBe(false);
  });

  it("is FALSE for a plain Error (e.g. SessionNotFoundError / network)", () => {
    expect(isRefreshTokenRejected(new Error("no session"))).toBe(false);
  });

  it("is FALSE for a 400 HttpResponseError whose body.error differs", () => {
    expect(
      isRefreshTokenRejected(
        new HttpResponseError({
          message: "Bad Request",
          statusText: "Bad Request",
          code: 400,
          body: { error: "invalid_request" },
        }),
      ),
    ).toBe(false);
  });

  it("is FALSE for a non-400 HttpResponseError (e.g. 500) even with the body.error", () => {
    expect(
      isRefreshTokenRejected(
        new HttpResponseError({
          message: "Server Error",
          statusText: "Internal Server Error",
          code: 500,
          body: { error: "invalid_subject_token" },
        }),
      ),
    ).toBe(false);
  });

  it("is FALSE (never throws) for a 400 HttpResponseError with a string body", () => {
    // The library types body as an object, but be defensive against a raw string
    // at runtime — the classifier must guard the shape, not throw.
    const err = new HttpResponseError({
      message: "Bad Request",
      statusText: "Bad Request",
      code: 400,
    });
    (err.response as { body?: unknown }).body = "invalid_subject_token";
    expect(isRefreshTokenRejected(err)).toBe(false);
  });

  it("is FALSE for null / undefined", () => {
    expect(isRefreshTokenRejected(null)).toBe(false);
    expect(isRefreshTokenRejected(undefined)).toBe(false);
  });
});

describe("classifyResponseStatus", () => {
  it("maps 401 → uninstalled, 200/undefined → installed, others → ambiguous", () => {
    expect(classifyResponseStatus(401)).toBe("uninstalled");
    expect(classifyResponseStatus(200)).toBe("installed");
    expect(classifyResponseStatus(undefined)).toBe("installed");
    expect(classifyResponseStatus(429)).toBe("ambiguous");
    expect(classifyResponseStatus(500)).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// Handler orchestration
// ---------------------------------------------------------------------------

describe("reconcileInstalls handler", () => {
  it("does NOT mark a shop that responds 200 (still installed)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "live.myshopify.com" }]);
    mockAdmin.mockResolvedValue(adminGraphql(async () => ({ status: 200 })));

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 0 });
  });

  it("marks a shop that fails with a 401 (revoked token), with source=reconciler", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "dead.myshopify.com" }]);
    mockAdmin.mockResolvedValue(
      adminGraphql(async () => {
        throw { response: { code: 401, statusText: "Unauthorized" } };
      }),
    );

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith("dead.myshopify.com", {
      source: "reconciler",
      message: expect.stringContaining("reconciler-detected uninstall"),
    });
    expect(result).toMatchObject({ checked: 1, marked: 1, skipped: 0 });
  });

  it("still classifies uninstalled (marked:1) when the shared mark reports an already-marked no-op (step retry)", async () => {
    // Retry scenario: a prior step attempt already marked this shop, so the shared
    // helper reports newlyMarked:false (no duplicate SHOP_UNINSTALLED event). The
    // probe still sees a revoked token, so the install-status classification stays
    // "uninstalled" and the summary counts it — the digest can't double-count
    // because the event is suppressed inside markShopUninstalledWithEvent.
    mockMark.mockResolvedValue({ newlyMarked: false, found: true });
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "already.myshopify.com" }]);
    mockAdmin.mockResolvedValue(
      adminGraphql(async () => {
        throw { response: { code: 401 } };
      }),
    );

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ checked: 1, marked: 1, skipped: 0 });
  });

  it("does NOT mark on THROTTLED / 429 (never churn a live merchant on a throttle)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "busy.myshopify.com" }]);
    mockAdmin.mockResolvedValue(
      adminGraphql(async () => {
        throw { response: { code: 429, statusText: "Too Many Requests" } };
      }),
    );

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("does NOT mark on a network error / timeout / 5xx", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "neterr.myshopify.com" },
      { id: "s2", domain: "fivexx.myshopify.com" },
    ]);
    mockAdmin
      .mockResolvedValueOnce(
        adminGraphql(async () => {
          throw new Error("network timeout ETIMEDOUT");
        }),
      )
      .mockResolvedValueOnce(
        adminGraphql(async () => {
          throw { response: { code: 500, statusText: "Internal Server Error" } };
        }),
      );

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 2, marked: 0, skipped: 2 });
  });

  it("does NOT mark when unauthenticated.admin throws (no session) — treated as ambiguous", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "nosession.myshopify.com" }]);
    mockAdmin.mockRejectedValue(new Error("no offline session found for shop"));

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("marks when unauthenticated.admin throws InvalidJwtError (expired offline token, refresh rejected)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "expired.myshopify.com" }]);
    mockAdmin.mockRejectedValue(new InvalidJwtError("invalid jwt"));

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith(
      "expired.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 1, marked: 1, skipped: 0 });
  });

  it("marks when unauthenticated.admin throws HttpResponseError 400 invalid_subject_token", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "revoked.myshopify.com" }]);
    mockAdmin.mockRejectedValue(
      new HttpResponseError({
        message: "Bad Request",
        statusText: "Bad Request",
        code: 400,
        body: { error: "invalid_subject_token" },
      }),
    );

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith(
      "revoked.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 1, marked: 1, skipped: 0 });
  });

  it("does NOT mark when unauthenticated.admin throws the library's transient Response(500) refresh wrapper", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "transient.myshopify.com" }]);
    mockAdmin.mockRejectedValue(new Response(undefined, { status: 500 }));

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("mixed batch: marks ONLY the uninstalled shop and reports correct summary counts", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "live.myshopify.com" },
      { id: "s2", domain: "dead.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) =>
      domain === "dead.myshopify.com"
        ? adminGraphql(async () => {
            throw { response: { code: 401 } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(mockMark).toHaveBeenCalledWith(
      "dead.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 2, marked: 1, skipped: 0 });
  });

  it("records a counts-only summary OpsEvent keyed on a constant (no shop domains)", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "live.myshopify.com" },
      { id: "s2", domain: "dead.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) =>
      domain === "dead.myshopify.com"
        ? adminGraphql(async () => {
            throw { response: { code: 401 } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );

    await runReconcile();

    expect(mockRecordOpsEvent).toHaveBeenCalledWith({
      eventType: "reconcile_summary",
      key: "reconcile-installs",
      message: expect.stringContaining("checked 2, marked 1"),
      metadata: { checked: 2, marked: 1, skipped: 0 },
    });
  });

  it("handles an empty active-shop set without probing or marking", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await runReconcile();

    expect(mockAdmin).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, marked: 0, skipped: 0 });
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { checked: 0, marked: 0, skipped: 0 } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("reconcileInstalls registration", () => {
  it("exports a defined Inngest function", () => {
    expect(reconcileInstalls).toBeDefined();
  });
});
