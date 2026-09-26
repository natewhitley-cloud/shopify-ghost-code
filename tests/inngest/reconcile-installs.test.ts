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
    RECONCILE_ABORTED: "reconcile_aborted",
  },
}));

vi.mock("../../app/services/ops-alert.server", () => ({
  sendOpsAlert: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({
  default: { shop: { findMany: vi.fn() }, session: { findMany: vi.fn() } },
}));

vi.mock("../../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
  sessionStorage: { loadSession: vi.fn(), storeSession: vi.fn() },
}));

vi.mock("../../app/models/shop.server", () => ({
  markShopUninstalledWithEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import db from "../../app/db.server";
import { logger } from "../../app/lib/logger.server";
import { recordOpsEvent } from "../../app/models/ops-event.server";
import { markShopUninstalledWithEvent } from "../../app/models/shop.server";
import { sendOpsAlert } from "../../app/services/ops-alert.server";
import { sessionStorage, unauthenticated } from "../../app/shopify.server";
import {
  classifyRefreshRejection,
  classifyResponseStatus,
  extractHttpStatus,
  isDefinitiveAuthFailure,
  isRefreshTokenRejected,
  isValidMyshopifyDomain,
  classifyExpiredTokenRefresh,
  formatReconcileSummary,
  isRefreshTokenExpired,
  reconcileInstalls,
  CB_FRACTION,
  CB_MIN_MARKS,
  shouldTripCircuitBreaker,
} from "../../inngest/functions/reconcile-installs";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockFindMany = (db as unknown as { shop: { findMany: ReturnType<typeof vi.fn> } }).shop
  .findMany;
const mockSessionFindMany = (db as unknown as { session: { findMany: ReturnType<typeof vi.fn> } })
  .session.findMany;
const mockAdmin = (unauthenticated as unknown as { admin: ReturnType<typeof vi.fn> }).admin;
const mockMark = markShopUninstalledWithEvent as ReturnType<typeof vi.fn>;
const mockRecordOpsEvent = recordOpsEvent as ReturnType<typeof vi.fn>;
const mockSendOpsAlert = sendOpsAlert as ReturnType<typeof vi.fn>;
const mockLoggerWarn = logger.warn as ReturnType<typeof vi.fn>;
const mockLoadSession = (sessionStorage as unknown as { loadSession: ReturnType<typeof vi.fn> })
  .loadSession;
const mockStoreSession = (sessionStorage as unknown as { storeSession: ReturnType<typeof vi.fn> })
  .storeSession;
const mockFetch = vi.fn();

/** An unauthenticated.admin resolution whose graphql behaves as configured. */
function adminGraphql(behavior: () => Promise<{ status?: number }>) {
  return { admin: { graphql: vi.fn(behavior) } };
}

/** The masked wrapper the library throws for a non-invalid_subject_token refresh failure. */
function maskedAdminFailure() {
  return new Response(undefined, { status: 500 });
}

/** A minimal offline Session stand-in the reconciler can mutate + store. */
function fakeOfflineSession(refreshToken = "old-refresh") {
  return {
    id: "offline_shop.myshopify.com",
    shop: "shop.myshopify.com",
    isOnline: false,
    accessToken: "old-access",
    scope: "read_themes",
    expires: new Date(0),
    refreshToken,
    refreshTokenExpires: new Date(0),
  };
}

async function runReconcile() {
  const step = createMockInngestStep();
  return getInngestHandler(reconcileInstalls)({ step });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMark.mockResolvedValue({ newlyMarked: true, found: true });
  mockRecordOpsEvent.mockResolvedValue(undefined);
  mockSendOpsAlert.mockResolvedValue({ sent: false, reason: "disabled" });
  mockLoadSession.mockResolvedValue(undefined);
  mockStoreSession.mockResolvedValue(true);
  // No offline session rows by default: nothing is token-expired (gc-gre).
  mockSessionFindMany.mockResolvedValue([]);
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  process.env.SHOPIFY_API_KEY = "test-key";
  process.env.SHOPIFY_API_SECRET = "test-secret";
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

describe("classifyRefreshRejection", () => {
  it("maps 404 → uninstalled (store gone, regardless of body)", () => {
    expect(classifyRefreshRejection(404, {})).toBe("uninstalled");
    expect(classifyRefreshRejection(404, null)).toBe("uninstalled");
    expect(classifyRefreshRejection(404, "not found")).toBe("uninstalled");
  });

  it("maps 401 invalid_request + 'requires an active refresh_token' → uninstalled (the REAL uninstall body)", () => {
    expect(
      classifyRefreshRejection(401, {
        error: "invalid_request",
        error_description: "This request requires an active refresh_token to be present.",
      }),
    ).toBe("uninstalled");
  });

  it("maps 400 invalid_subject_token → uninstalled", () => {
    expect(classifyRefreshRejection(400, { error: "invalid_subject_token" })).toBe("uninstalled");
  });

  it("maps 401/400 invalid_grant → uninstalled", () => {
    expect(classifyRefreshRejection(401, { error: "invalid_grant" })).toBe("uninstalled");
    expect(classifyRefreshRejection(400, { error: "invalid_grant" })).toBe("uninstalled");
  });

  it("maps 401/400 invalid_client → ambiguous (OUR credential problem, the mass-churn guard)", () => {
    expect(classifyRefreshRejection(401, { error: "invalid_client" })).toBe("ambiguous");
    expect(classifyRefreshRejection(400, { error: "invalid_client" })).toBe("ambiguous");
  });

  it("maps 401 invalid_request WITHOUT a refresh_token description → ambiguous", () => {
    expect(
      classifyRefreshRejection(401, {
        error: "invalid_request",
        error_description: "The client authentication failed.",
      }),
    ).toBe("ambiguous");
  });

  it("maps 401/400 with an empty / absent / string / null body → ambiguous (never throws)", () => {
    expect(classifyRefreshRejection(401, {})).toBe("ambiguous");
    expect(classifyRefreshRejection(401, null)).toBe("ambiguous");
    expect(classifyRefreshRejection(401, "invalid_subject_token")).toBe("ambiguous");
    expect(classifyRefreshRejection(400, undefined)).toBe("ambiguous");
    expect(classifyRefreshRejection(400, { error: 42 })).toBe("ambiguous");
  });

  it("maps 5xx / other statuses → ambiguous", () => {
    expect(classifyRefreshRejection(500, { error: "invalid_grant" })).toBe("ambiguous");
    expect(classifyRefreshRejection(503, {})).toBe("ambiguous");
    expect(classifyRefreshRejection(429, {})).toBe("ambiguous");
  });
});

describe("isValidMyshopifyDomain", () => {
  it("is TRUE for a well-formed *.myshopify.com domain", () => {
    expect(isValidMyshopifyDomain("shop.myshopify.com")).toBe(true);
    expect(isValidMyshopifyDomain("my-cool-shop123.myshopify.com")).toBe(true);
  });

  it("is FALSE for a non-myshopify domain", () => {
    expect(isValidMyshopifyDomain("evil.com")).toBe(false);
  });

  it("is FALSE for a lookalike suffix domain", () => {
    expect(isValidMyshopifyDomain("shop.myshopify.com.evil.com")).toBe(false);
  });

  it("is FALSE for uppercase (case-sensitive; domains are stored lowercase)", () => {
    expect(isValidMyshopifyDomain("SHOP.myshopify.com")).toBe(false);
  });

  it("is FALSE for an empty string", () => {
    expect(isValidMyshopifyDomain("")).toBe(false);
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
    // A healthy companion shop (200) rides along so this stays a NORMAL single-real-
    // uninstall case: post-gc-5ha the circuit breaker trips at 100% churn (checked>=1),
    // so a lone 401 at N=1 now pages-and-aborts (covered by the dedicated N=1 abort
    // test below). Here 1-of-2 is below the breaker → the dead shop IS marked.
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "dead.myshopify.com" },
      { id: "s2", domain: "live.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) =>
      domain === "dead.myshopify.com"
        ? adminGraphql(async () => {
            throw { response: { code: 401, statusText: "Unauthorized" } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith("dead.myshopify.com", {
      source: "reconciler",
      message: expect.stringContaining("reconciler-detected uninstall"),
    });
    expect(result).toMatchObject({ checked: 2, marked: 1, skipped: 0 });
  });

  it("still classifies uninstalled (marked:1) when the shared mark reports an already-marked no-op (step retry)", async () => {
    // Retry scenario: a prior step attempt already marked this shop, so the shared
    // helper reports newlyMarked:false (no duplicate SHOP_UNINSTALLED event). The
    // probe still sees a revoked token, so the install-status classification stays
    // "uninstalled" and the summary counts it — the digest can't double-count
    // because the event is suppressed inside markShopUninstalledWithEvent.
    mockMark.mockResolvedValue({ newlyMarked: false, found: true });
    // Companion healthy shop keeps the breaker closed (1-of-2, not 100% churn) so
    // the retry-marks-again path is still exercised post-gc-5ha (see the 401 test).
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "already.myshopify.com" },
      { id: "s2", domain: "live.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) =>
      domain === "already.myshopify.com"
        ? adminGraphql(async () => {
            throw { response: { code: 401 } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ checked: 2, marked: 1, skipped: 0 });
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
    // Companion healthy shop keeps the breaker closed so this classifier still
    // drives a real mark post-gc-5ha (see the 401 test for the rationale).
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "expired.myshopify.com" },
      { id: "s2", domain: "live.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) => {
      if (domain === "expired.myshopify.com") throw new InvalidJwtError("invalid jwt");
      return adminGraphql(async () => ({ status: 200 }));
    });

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith(
      "expired.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 2, marked: 1, skipped: 0 });
  });

  it("marks when unauthenticated.admin throws HttpResponseError 400 invalid_subject_token", async () => {
    // Companion healthy shop keeps the breaker closed so this classifier still
    // drives a real mark post-gc-5ha (see the 401 test for the rationale).
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "revoked.myshopify.com" },
      { id: "s2", domain: "live.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) => {
      if (domain === "revoked.myshopify.com")
        throw new HttpResponseError({
          message: "Bad Request",
          statusText: "Bad Request",
          code: 400,
          body: { error: "invalid_subject_token" },
        });
      return adminGraphql(async () => ({ status: 200 }));
    });

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith(
      "revoked.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 2, marked: 1, skipped: 0 });
  });

  it("does NOT mark when unauthenticated.admin throws the library's transient Response(500) refresh wrapper", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "transient.myshopify.com" }]);
    mockAdmin.mockRejectedValue(new Response(undefined, { status: 500 }));

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  // --- Masked-failure disambiguation via rawRefreshProbe ------------------
  // The library masks a real 401/404 refresh rejection as `new Response(500)`,
  // so unauthenticated.admin throws a 500 wrapper. The reconciler must re-probe
  // Shopify's raw refresh endpoint to disambiguate installed vs uninstalled.

  it("masked-500 + raw refresh 401 WITH a refresh-token error body → MARKED uninstalled (source=reconciler)", async () => {
    // Companion healthy shop (200) keeps the breaker closed so this masked-500
    // classifier still drives a real mark post-gc-5ha (see the 401 test). The live
    // shop resolves before the raw-refresh path, so it never touches loadSession/fetch.
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "expired401.myshopify.com" },
      { id: "s2", domain: "live.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) => {
      if (domain === "expired401.myshopify.com") throw maskedAdminFailure();
      return adminGraphql(async () => ({ status: 200 }));
    });
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({
      status: 401,
      json: async () => ({
        error: "invalid_request",
        error_description: "This request requires an active refresh_token to be present.",
      }),
    });

    const result = await runReconcile();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://expired401.myshopify.com/admin/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockMark).toHaveBeenCalledWith(
      "expired401.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 2, marked: 1, skipped: 0 });
  });

  it("masked-500 + raw refresh 401 invalid_client → NOT marked (credential error, the mass-churn guard)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "credbad.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({
      status: 401,
      json: async () => ({ error: "invalid_client" }),
    });

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + raw refresh 400 invalid_client → NOT marked (credential error, the mass-churn guard)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "credbad400.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({
      status: 400,
      json: async () => ({ error: "invalid_client" }),
    });

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + raw refresh 401 with empty body → NOT marked (ambiguous, credential error can't be ruled out)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "empty401.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({ status: 401, json: async () => ({}) });

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + raw refresh 404 (closed store) → MARKED uninstalled", async () => {
    // Companion healthy shop keeps the breaker closed so this classifier still
    // drives a real mark post-gc-5ha (see the 401 test for the rationale).
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "closed404.myshopify.com" },
      { id: "s2", domain: "live.myshopify.com" },
    ]);
    mockAdmin.mockImplementation(async (domain: string) => {
      if (domain === "closed404.myshopify.com") throw maskedAdminFailure();
      return adminGraphql(async () => ({ status: 200 }));
    });
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({ status: 404, json: async () => ({}) });

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith(
      "closed404.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 2, marked: 1, skipped: 0 });
  });

  it("masked-500 + raw refresh 500 → NOT marked (ambiguous, never churn on a blip)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "blip500.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({ status: 500, json: async () => ({}) });

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockStoreSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + raw refresh network throw → NOT marked (ambiguous)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "neterr.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockRejectedValue(new Error("network unreachable ECONNREFUSED"));

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + raw refresh 200 → NOT marked AND stores the rotated session", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "installed200.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession("old-refresh"));
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 3600,
        refresh_token: "new-refresh",
        refresh_token_expires_in: 7200,
        scope: "read_themes,read_products",
      }),
    });

    const result = await runReconcile();

    // Invariant #2: a still-installed shop's rotated session MUST be persisted so
    // a later run doesn't false-churn it on a now-stale stored refresh token.
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockStoreSession).toHaveBeenCalledTimes(1);
    const stored = mockStoreSession.mock.calls[0][0];
    expect(stored.accessToken).toBe("new-access");
    expect(stored.refreshToken).toBe("new-refresh");
    expect(stored.expires).toBeInstanceOf(Date);
    expect(stored.refreshTokenExpires).toBeInstanceOf(Date);
    expect(stored.scope).toBe("read_themes,read_products");
    // A raw-200 is a CONFIRMED install, so it is neither marked nor skipped-transient.
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 0 });
  });

  it("masked-500 + no refreshToken → NOT marked (can't probe, ambiguous)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "norefresh.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue({ ...fakeOfflineSession(), refreshToken: undefined });

    const result = await runReconcile();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + no session → NOT marked (can't probe, ambiguous)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "nosession.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(undefined);

    const result = await runReconcile();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + non-myshopify domain (evil.com) → NO fetch, NOT marked (ambiguous)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "evil.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());

    const result = await runReconcile();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
    // No secret in the warning log.
    for (const call of mockLoggerWarn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(process.env.SHOPIFY_API_SECRET ?? "");
    }
  });

  it("masked-500 + lookalike domain (shop.myshopify.com.evil.com) → NO fetch, NOT marked (ambiguous)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "shop.myshopify.com.evil.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());

    const result = await runReconcile();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("logs the invalid domain as a structured field so the corrupt row is traceable", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "shop.myshopify.com.evil.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());

    await runReconcile();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("domain failed validation"),
      expect.objectContaining({
        function: "reconcile-installs",
        domain: "shop.myshopify.com.evil.com",
      }),
    );
  });

  it("masked-500 + uppercase domain (SHOP.myshopify.com) → NO fetch, NOT marked (ambiguous, case-sensitive)", async () => {
    // Domains are stored lowercase; uppercase is unexpected input, not a
    // legitimate variant, so it is rejected rather than silently lowercased.
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "SHOP.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());

    const result = await runReconcile();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1 });
  });

  it("masked-500 + valid myshopify domain → STILL fetches (the guard doesn't block real shops)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "validguard.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({ status: 500, json: async () => ({}) });

    await runReconcile();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://validguard.myshopify.com/admin/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
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
      metadata: { checked: 2, marked: 1, skipped: 0, tokenExpired: 0 },
    });
  });

  it("handles an empty active-shop set without probing or marking", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await runReconcile();

    expect(mockAdmin).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, marked: 0, skipped: 0 });
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { checked: 0, marked: 0, skipped: 0, tokenExpired: 0 } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Partial-rotation warning (Fix 3)
// ---------------------------------------------------------------------------

describe("reconcileInstalls partial-rotation warning", () => {
  it("masked-500 + raw 200 with refresh_token but NO refresh_token_expires_in → warns, does NOT overwrite refreshToken", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "partial.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession("old-refresh"));
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 3600,
        refresh_token: "new-refresh",
        // refresh_token_expires_in deliberately absent (the partial signature)
      }),
    });

    const result = await runReconcile();

    // Warned about the unexpected shape...
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("unexpected refresh response shape"),
      expect.objectContaining({ hasRefreshToken: true, hasRefreshExpiry: false }),
    );
    // ...but did NOT rotate the refresh token (only both-present rotates). The
    // access token still updates; the stale refresh_token is retained (surfaced).
    expect(mockStoreSession).toHaveBeenCalledTimes(1);
    const stored = mockStoreSession.mock.calls[0][0];
    expect(stored.accessToken).toBe("new-access");
    expect(stored.refreshToken).toBe("old-refresh");
    expect(mockMark).not.toHaveBeenCalled();
    // Still a confirmed install (raw 200), so neither marked nor skipped-transient.
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// Run-level circuit breaker (Fix 2)
// ---------------------------------------------------------------------------

describe("reconcileInstalls circuit breaker", () => {
  it("ABORTS and marks NOTHING when the count exceeds the threshold (mass-churn signature)", async () => {
    // 12 active shops, EVERY one probes uninstalled (e.g. a systemic fault that
    // produced 401s across the base). threshold = max(3, ceil(0.5*12)=6) = 6,
    // so 12/12 trips the breaker (all-probed AND >=threshold): nothing is marked,
    // the operator is paged.
    const shops = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      domain: `shop${i}.myshopify.com`,
    }));
    mockFindMany.mockResolvedValue(shops);
    mockAdmin.mockResolvedValue(
      adminGraphql(async () => {
        throw { response: { code: 401 } };
      }),
    );

    const result = await runReconcile();

    // The critical assertion: NOT ONE shop was marked.
    expect(mockMark).not.toHaveBeenCalled();
    // An abort OpsEvent was recorded (counts-only message AND metadata; domains
    // ride the operator email only — see the GDPR test below).
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        key: "reconcile-installs",
        message: expect.stringContaining("ABORTED by circuit breaker"),
        metadata: {
          checked: 12,
          probed: 12,
          skipped: 0,
          tokenExpired: 0,
          wouldMark: 12,
          threshold: 6,
        },
      }),
    );
    // The summary row is NOT written on abort (only the abort event).
    expect(mockRecordOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "reconcile_summary" }),
    );
    // The operator was paged.
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "aborted-circuit-breaker",
      checked: 12,
      wouldMark: 12,
    });
  });

  it("does NOT trip for a small number of real uninstalls below the threshold — those ARE marked", async () => {
    // 8 shops, 3 uninstalled, 5 installed. threshold = max(3, ceil(0.5*8)=4) = 4,
    // so 3 < 4 and not all-probed: the breaker stays closed and the 3 real
    // uninstalls are marked.
    const dead = new Set(["dead1.myshopify.com", "dead2.myshopify.com", "dead3.myshopify.com"]);
    const shops = [
      ...[...dead].map((domain, i) => ({ id: `d${i}`, domain })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, domain: `live${i}.myshopify.com` })),
    ];
    mockFindMany.mockResolvedValue(shops);
    mockAdmin.mockImplementation(async (domain: string) =>
      dead.has(domain)
        ? adminGraphql(async () => {
            throw { response: { code: 401 } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledTimes(3);
    for (const domain of dead) {
      expect(mockMark).toHaveBeenCalledWith(
        domain,
        expect.objectContaining({ source: "reconciler" }),
      );
    }
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_summary",
        metadata: { checked: 8, marked: 3, skipped: 0, tokenExpired: 0 },
      }),
    );
    expect(result).toMatchObject({ status: "completed", checked: 8, marked: 3, skipped: 0 });
  });

  // Build N shops, the first `dead` of them probing 401 (uninstalled), the rest 200.
  function seedShops(total: number, dead: number) {
    const deadDomains = new Set(Array.from({ length: dead }, (_, i) => `dead${i}.myshopify.com`));
    const shops = [
      ...Array.from({ length: dead }, (_, i) => ({
        id: `d${i}`,
        domain: `dead${i}.myshopify.com`,
      })),
      ...Array.from({ length: total - dead }, (_, i) => ({
        id: `l${i}`,
        domain: `live${i}.myshopify.com`,
      })),
    ];
    mockFindMany.mockResolvedValue(shops);
    mockAdmin.mockImplementation(async (domain: string) =>
      deadDomains.has(domain)
        ? adminGraphql(async () => {
            throw { response: { code: 401 } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );
  }

  it("TRIPS at a SMALL base when ALL shops are wrongly classified uninstalled (the old silent hole: checked=5, 5/5)", async () => {
    // The regression the old MAX(CB_ABS_CAP=5, ...) form silently PASSED: with
    // checked=5, ceil(0.5*5)=3 and the old cap pinned the threshold at 5, so 5
    // was NOT > 5 — the breaker never tripped and a systemic fault could churn
    // the entire tiny base. New rule: all-probed-marked (N>=3) always trips.
    // threshold = max(3, ceil(0.5*5)=3) = 3.
    seedShops(5, 5);

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        key: "reconcile-installs",
        message: expect.stringContaining("ABORTED by circuit breaker"),
        metadata: {
          checked: 5,
          probed: 5,
          skipped: 0,
          tokenExpired: 0,
          wouldMark: 5,
          threshold: 3,
        },
      }),
    );
    expect(mockRecordOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "reconcile_summary" }),
    );
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "aborted-circuit-breaker",
      checked: 5,
      wouldMark: 5,
    });
  });

  it("TRIPS at checked=3 when 3/3 are uninstalled (all-probed at the N>=3 floor)", async () => {
    // threshold = max(3, ceil(0.5*3)=2) = 3; all-probed (3===3, N>=3) trips.
    seedShops(3, 3);

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        metadata: {
          checked: 3,
          probed: 3,
          skipped: 0,
          tokenExpired: 0,
          wouldMark: 3,
          threshold: 3,
        },
      }),
    );
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "aborted-circuit-breaker",
      checked: 3,
      wouldMark: 3,
    });
  });

  it("does NOT trip at checked=10 with 4 marks (< half the base) — those 4 ARE marked", async () => {
    // threshold = max(3, ceil(0.5*10)=5) = 5; 4 < 5 and not all-probed → closed.
    seedShops(10, 4);

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledTimes(4);
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_summary",
        metadata: { checked: 10, marked: 4, skipped: 0, tokenExpired: 0 },
      }),
    );
    expect(result).toMatchObject({ status: "completed", checked: 10, marked: 4, skipped: 0 });
  });

  it("TRIPS at checked=10 with 5 marks (>= half the base) — marks NOTHING", async () => {
    // threshold = max(3, ceil(0.5*10)=5) = 5; 5 >= 5 trips via the fraction.
    seedShops(10, 5);

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        metadata: {
          checked: 10,
          probed: 10,
          skipped: 0,
          tokenExpired: 0,
          wouldMark: 5,
          threshold: 5,
        },
      }),
    );
    expect(mockRecordOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "reconcile_summary" }),
    );
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "aborted-circuit-breaker",
      checked: 10,
      wouldMark: 5,
    });
  });

  it("TRIPS at checked=1 when the ONLY active shop probes uninstalled (100% churn) — marks NOTHING", async () => {
    // Fix (gc-5ha): the all-probed clause now fires at ANY base size (checked>=1),
    // not just N>=3. threshold = max(3, ceil(0.5*1)=1) = 3, so the fraction clause
    // is 1 >= 3 = false; the trip comes SOLELY from all-probed (1===1). This is the
    // intended conservative backstop behavior: a lone active shop classifying
    // "uninstalled" pages-and-aborts rather than auto-churning the entire base.
    // (Real single uninstalls are handled directly by the app/uninstalled webhook;
    // this reconciler only catches MISSED webhooks.)
    seedShops(1, 1);

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        metadata: {
          checked: 1,
          probed: 1,
          skipped: 0,
          tokenExpired: 0,
          wouldMark: 1,
          threshold: 3,
        },
      }),
    );
    expect(mockRecordOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "reconcile_summary" }),
    );
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "aborted-circuit-breaker",
      checked: 1,
      wouldMark: 1,
    });
  });

  it("TRIPS at checked=2 when BOTH active shops probe uninstalled (100% churn) — marks NOTHING", async () => {
    // The exact silent hole the old `checked >= 3` guard left: at checked=2,
    // wouldMark=2, threshold=max(3, ceil(0.5*2)=1)=3, the old form had all-probed
    // gated off (2<3) AND the fraction false (2<3), so BOTH shops were auto-marked
    // with no page. The new `checked >= 1` all-probed clause trips instead.
    seedShops(2, 2);

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        metadata: {
          checked: 2,
          probed: 2,
          skipped: 0,
          tokenExpired: 0,
          wouldMark: 2,
          threshold: 3,
        },
      }),
    );
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "aborted-circuit-breaker",
      checked: 2,
      wouldMark: 2,
    });
  });

  // Build shops with explicit per-shop outcomes: "dead" probes 401 (uninstalled),
  // "live" probes 200 (installed), "skip" probes 429 (ambiguous → skipped).
  function seedOutcomes(outcomes: Array<"dead" | "live" | "skip">) {
    const byDomain = new Map(outcomes.map((o, i) => [`${o}${i}.myshopify.com`, o]));
    mockFindMany.mockResolvedValue(
      [...byDomain.keys()].map((domain, i) => ({ id: `s${i}`, domain })),
    );
    mockAdmin.mockImplementation(async (domain: string) => {
      const outcome = byDomain.get(domain);
      if (outcome === "live") return adminGraphql(async () => ({ status: 200 }));
      const code = outcome === "dead" ? 401 : 429;
      return adminGraphql(async () => {
        throw { response: { code } };
      });
    });
  }

  it("TRIPS when a permanently skipped row hides 100% churn of the PROBED base (3 shops, 1 skipped, 2 uninstalled)", async () => {
    // Old denominator (checked=3): all-probed 2===3 false; threshold =
    // max(3, ceil(0.5*3)=2) = 3, 2 >= 3 false → both real shops auto-churned.
    // New denominator probed = 3 - 1 = 2: all-probed 2===2 → trips.
    seedOutcomes(["skip", "dead", "dead"]);

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    // Metadata carries probed/skipped so the digest can show WHY it tripped
    // (the breaker decides on probed, not checked); threshold = max(3, ceil(0.5*2)=1) = 3.
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        message: expect.stringContaining("2 of 2 probed"),
        metadata: {
          checked: 3,
          probed: 2,
          skipped: 1,
          tokenExpired: 0,
          wouldMark: 2,
          threshold: 3,
        },
      }),
    );
    expect(mockRecordOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "reconcile_summary" }),
    );
    expect(result).toMatchObject({ status: "aborted-circuit-breaker", checked: 3, wouldMark: 2 });
  });

  it("does NOT trip when EVERY shop is skipped (probed=0, wouldMark=0)", async () => {
    seedOutcomes(["skip", "skip", "skip"]);

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_summary",
        metadata: { checked: 3, marked: 0, skipped: 3, tokenExpired: 0 },
      }),
    );
    expect(result).toMatchObject({ status: "completed", checked: 3, marked: 0, skipped: 3 });
  });

  it("still marks a lone real uninstall at checked=10 with 0 skipped (normal path unchanged)", async () => {
    // probed=10, threshold = max(3, ceil(0.5*10)=5) = 5; 1 < 5, 1 !== 10 → closed.
    seedShops(10, 1);

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "completed", checked: 10, marked: 1, skipped: 0 });
  });

  // --- Hybrid rule (owner decision 1A) -----------------------------------
  // tripped = (checked>=1 && w===checked) || (probed>=2 && w===probed)
  //           || w >= max(CB_MIN_MARKS, ceil(CB_FRACTION*probed))
  function expectTripped(result: unknown, checked: number, wouldMark: number) {
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "reconcile_aborted" }),
    );
    expect(result).toMatchObject({ status: "aborted-circuit-breaker", checked, wouldMark });
  }
  function expectMarked(result: unknown, checked: number, marked: number, skipped: number) {
    expect(mockMark).toHaveBeenCalledTimes(marked);
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
    expect(mockRecordOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "reconcile_aborted" }),
    );
    expect(result).toMatchObject({ status: "completed", checked, marked, skipped });
  }

  it("does NOT trip on ordinary churn hidden among many skips (checked=10, skipped=9, wouldMark=1) — marks the 1 shop", async () => {
    // probed=1: the probed>=2 floor keeps a lone classified shop from being
    // read as 100% systemic churn; 1 !== 10 and 1 < 3, so the real uninstall is marked.
    seedOutcomes(["skip", "skip", "skip", "skip", "dead", "skip", "skip", "skip", "skip", "skip"]);
    const result = await runReconcile();
    expectMarked(result, 10, 1, 9);
    expect(mockMark).toHaveBeenCalledWith("dead4.myshopify.com", expect.anything());
  });

  it("TRIPS at checked=1, skipped=0, wouldMark=1 (original N=1 design preserved)", async () => {
    seedOutcomes(["dead"]);
    const result = await runReconcile();
    expectTripped(result, 1, 1);
  });

  it("does NOT trip at checked=2, skipped=1, wouldMark=1 — marks the 1 shop", async () => {
    seedOutcomes(["skip", "dead"]);
    const result = await runReconcile();
    expectMarked(result, 2, 1, 1);
  });

  it("TRIPS at checked=5, skipped=3, wouldMark=2 (documented residual: 2 real uninstalls on a throttled day pages)", async () => {
    seedOutcomes(["skip", "skip", "skip", "dead", "dead"]);
    const result = await runReconcile();
    expectTripped(result, 5, 2);
  });

  it("does NOT trip at checked=4, skipped=4, wouldMark=0 — marks nothing", async () => {
    seedOutcomes(["skip", "skip", "skip", "skip"]);
    const result = await runReconcile();
    expectMarked(result, 4, 0, 4);
  });

  it("does NOT trip at checked=10, skipped=0, wouldMark=1 — marks the 1 shop", async () => {
    seedOutcomes(["dead", "live", "live", "live", "live", "live", "live", "live", "live", "live"]);
    const result = await runReconcile();
    expectMarked(result, 10, 1, 0);
  });

  it("keeps shop domains OUT of the durable OpsEvent (message + metadata) and rides them on the operator email only", async () => {
    // Fix (GDPR completeness): deleteShopData purges OpsEvents by key /
    // metadata.shop|shopDomain|shopId — it CANNOT reach a domain buried in the
    // free-text message. So the durable RECONCILE_ABORTED row must carry NO
    // per-shop domain (message counts-only, metadata counts-only); the domain list
    // rides the paged operator email only (the operator inbox is not a GDPR store).
    seedShops(3, 3); // dead0/1/2.myshopify.com, all uninstalled → trips

    await runReconcile();

    const abortCall = mockRecordOpsEvent.mock.calls.find(
      ([arg]) => arg.eventType === "reconcile_aborted",
    );
    expect(abortCall).toBeDefined();
    const durableMessage = abortCall![0].message as string;
    // No domain and no "Domains:" list survives in the durable row's message...
    expect(durableMessage).not.toContain("Domains:");
    expect(durableMessage).not.toContain(".myshopify.com");
    // ...nor anywhere in the structured metadata (counts only).
    expect(JSON.stringify(abortCall![0].metadata)).not.toContain(".myshopify.com");

    // ...but the operator email body DOES include the full domain list.
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    const emailBody = mockSendOpsAlert.mock.calls[0][1] as string;
    expect(emailBody).toContain("Domains:");
    expect(emailBody).toContain("dead0.myshopify.com");
    expect(emailBody).toContain("dead1.myshopify.com");
    expect(emailBody).toContain("dead2.myshopify.com");
  });
});

// ---------------------------------------------------------------------------
// shouldTripCircuitBreaker (pure predicate, owner decision 1A)
// ---------------------------------------------------------------------------

describe("shouldTripCircuitBreaker", () => {
  it.each([
    // [checked, skipped, wouldMark, expected]
    [3, 1, 2, true], // the original-rule gap 02da341 closed
    [10, 9, 1, false], // ordinary churn among many skips
    [1, 0, 1, true], // original N=1 design
    [2, 1, 1, false],
    [5, 3, 2, true], // documented residual
    [4, 4, 0, false],
    [10, 0, 1, false],
    [0, 0, 0, false], // empty base
    [10, 0, 5, true], // fraction clause
    [10, 0, 4, false],
  ])("checked=%i skipped=%i wouldMark=%i → %s", (checked, skipped, wouldMark, expected) => {
    expect(shouldTripCircuitBreaker({ checked, skipped, wouldMark })).toBe(expected);
  });

  it("trips in EVERY case the original pre-02da341 rule tripped (never less protective)", () => {
    const originalTrips = (checked: number, w: number) =>
      (checked >= 1 && w === checked) ||
      w >= Math.max(CB_MIN_MARKS, Math.ceil(CB_FRACTION * checked));
    let cases = 0;
    let originalTripCases = 0;
    const regressions: string[] = [];
    for (let checked = 0; checked <= 12; checked++) {
      for (let skipped = 0; skipped <= checked; skipped++) {
        for (let wouldMark = 0; wouldMark <= checked - skipped; wouldMark++) {
          cases++;
          if (!originalTrips(checked, wouldMark)) continue;
          originalTripCases++;
          if (!shouldTripCircuitBreaker({ checked, skipped, wouldMark })) {
            regressions.push(`checked=${checked} skipped=${skipped} wouldMark=${wouldMark}`);
          }
        }
      }
    }
    expect(cases).toBe(455);
    expect(originalTripCases).toBeGreaterThan(0);
    expect(regressions).toEqual([]);
  });

  it("never trips when nothing would be marked", () => {
    for (let checked = 0; checked <= 12; checked++) {
      for (let skipped = 0; skipped <= checked; skipped++) {
        expect(shouldTripCircuitBreaker({ checked, skipped, wouldMark: 0 })).toBe(false);
      }
    }
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

// ---------------------------------------------------------------------------
// Expired refresh token -> token_expired, never probed or marked (gc-gre)
// ---------------------------------------------------------------------------

describe("isRefreshTokenExpired", () => {
  const NOW = new Date("2026-09-26T12:00:00Z");

  it.each([
    ["in the past (de66e6: 2026-08-12)", new Date("2026-08-12T00:00:00Z"), true],
    ["1 ms in the past", new Date(NOW.getTime() - 1), true],
    ["exactly now (not yet expired)", new Date(NOW.getTime()), false],
    ["in the future", new Date("2027-01-01T00:00:00Z"), false],
    ["null (non-expiring legacy offline token)", null, false],
  ])("%s -> %s", (_name, expires, expected) => {
    expect(isRefreshTokenExpired(expires, NOW)).toBe(expected);
  });
});

describe("formatReconcileSummary", () => {
  it("renders every count, including a zero token-expired count", () => {
    expect(formatReconcileSummary({ checked: 10, marked: 1, skipped: 2, tokenExpired: 0 })).toBe(
      "reconcile: checked 10, marked 1, skipped-transient 2, token-expired (dormant) 0",
    );
    expect(formatReconcileSummary({ checked: 11, marked: 0, skipped: 0, tokenExpired: 1 })).toBe(
      "reconcile: checked 11, marked 0, skipped-transient 0, token-expired (dormant) 1",
    );
  });
});

describe("reconcileInstalls token-expired bucket (gc-gre)", () => {
  const EXPIRED = "de66e6-c4.myshopify.com";
  const PAST = new Date("2026-08-12T00:00:00Z");
  const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  /** Offline session rows as db.session.findMany returns them (id + expiry). */
  function sessionsFor(rows: Array<[domain: string, expires: Date | null]>) {
    mockSessionFindMany.mockResolvedValue(
      rows.map(([domain, refreshTokenExpires]) => ({
        id: `offline_${domain}`,
        refreshTokenExpires,
      })),
    );
  }

  /** The masked admin failure + a raw refresh 401 with NO recognized error body. */
  function maskedWithUnrecognized401() {
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 401 }));
  }

  it("reads refresh-token expiry for the active shops' OFFLINE session ids in one query", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "a.myshopify.com" },
      { id: "s2", domain: EXPIRED },
    ]);
    mockAdmin.mockResolvedValue(adminGraphql(async () => ({ status: 200 })));

    await runReconcile();

    expect(mockSessionFindMany).toHaveBeenCalledTimes(1);
    expect(mockSessionFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["offline_a.myshopify.com", `offline_${EXPIRED}`] } },
      select: { id: true, refreshTokenExpires: true },
    });
  });

  // Replaces the vacuous "never probed, never marked" test (audit 2 #1): an
  // expired-token shop IS probed with the raw refresh, and a 404 vs anything
  // else is the whole decision.
  it("expired + raw refresh 404 (store gone): MARKED uninstalled, no Admin API call", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: EXPIRED },
      { id: "s2", domain: "live1.myshopify.com" },
      { id: "s3", domain: "live2.myshopify.com" },
    ]);
    sessionsFor([[EXPIRED, PAST]]);
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    mockAdmin.mockResolvedValue(adminGraphql(async () => ({ status: 200 })));

    const result = await runReconcile();

    expect(mockAdmin).not.toHaveBeenCalledWith(EXPIRED); // no Admin API call for it
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(`https://${EXPIRED}/admin/oauth/access_token`);
    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(mockMark).toHaveBeenCalledWith(
      EXPIRED,
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ status: "completed", checked: 3, marked: 1, tokenExpired: 0 });
  });

  it("expired + raw refresh 401 with an unknown body: token_expired, NOT marked, counted", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: EXPIRED }]);
    sessionsFor([[EXPIRED, PAST]]);
    maskedWithUnrecognized401();

    const result = await runReconcile();

    expect(mockAdmin).not.toHaveBeenCalled(); // no Admin API call
    expect(mockFetch).toHaveBeenCalledTimes(1); // the raw refresh IS issued
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      checked: 1,
      marked: 0,
      skipped: 0,
      tokenExpired: 1,
    });
    expect(mockRecordOpsEvent).toHaveBeenCalledWith({
      eventType: "reconcile_summary",
      key: "reconcile-installs",
      message: "reconcile: checked 1, marked 0, skipped-transient 0, token-expired (dormant) 1",
      metadata: { checked: 1, marked: 0, skipped: 0, tokenExpired: 1 },
    });
  });

  it.each([
    [
      "401 with the refresh-token body that marks an UNEXPIRED shop",
      401,
      {
        error: "invalid_request",
        error_description: "This request requires an active refresh_token",
      },
    ],
    ["400 invalid_grant", 400, { error: "invalid_grant" }],
    ["500", 500, {}],
  ])("expired + raw refresh %s: token_expired, never marked", async (_label, status, body) => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: EXPIRED }]);
    sessionsFor([[EXPIRED, PAST]]);
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ marked: 0, skipped: 0, tokenExpired: 1 });
  });

  it("expired + no session / network error: token_expired, never marked", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: EXPIRED },
      { id: "s2", domain: "net-expired.myshopify.com" },
    ]);
    sessionsFor([
      [EXPIRED, PAST],
      ["net-expired.myshopify.com", PAST],
    ]);
    mockLoadSession.mockImplementation(async (id: string) =>
      id === `offline_${EXPIRED}` ? undefined : fakeOfflineSession(),
    );
    mockFetch.mockRejectedValue(new Error("ECONNRESET"));

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 2, marked: 0, skipped: 0, tokenExpired: 2 });
  });

  it("expired + raw refresh 200: stores the rotated session and stays token_expired", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: EXPIRED }]);
    sessionsFor([[EXPIRED, PAST]]);
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
          refresh_token: "new-refresh",
          refresh_token_expires_in: 7776000,
        }),
        { status: 200 },
      ),
    );

    const result = await runReconcile();

    expect(mockStoreSession).toHaveBeenCalledTimes(1); // rotation-store invariant kept
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ marked: 0, tokenExpired: 1 });
  });

  it("still probes an UNEXPIRED token, and an unrecognized raw-refresh 401 stays ambiguous (skipped)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "fresh.myshopify.com" }]);
    sessionsFor([["fresh.myshopify.com", FUTURE]]);
    maskedWithUnrecognized401();

    const result = await runReconcile();

    expect(mockAdmin).toHaveBeenCalledWith("fresh.myshopify.com");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 1, tokenExpired: 0 });
  });

  it("probes a null refreshTokenExpires (non-expiring legacy token) exactly as before", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: "legacy.myshopify.com" },
      { id: "s2", domain: "dead.myshopify.com" },
      { id: "s3", domain: "live.myshopify.com" },
    ]);
    sessionsFor([["legacy.myshopify.com", null]]);
    mockAdmin.mockImplementation(async (domain: string) =>
      domain === "dead.myshopify.com"
        ? adminGraphql(async () => {
            throw { response: { code: 401 } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );

    const result = await runReconcile();

    expect(mockAdmin).toHaveBeenCalledWith("legacy.myshopify.com");
    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(mockMark).toHaveBeenCalledWith("dead.myshopify.com", expect.anything());
    expect(result).toMatchObject({ checked: 3, marked: 1, skipped: 0, tokenExpired: 0 });
  });

  it("probes a shop with no offline session row (not expired; probes and classifies as before)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "nosession.myshopify.com" }]);
    sessionsFor([]);
    mockAdmin.mockResolvedValue(adminGraphql(async () => ({ status: 200 })));

    const result = await runReconcile();

    expect(mockAdmin).toHaveBeenCalledWith("nosession.myshopify.com");
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 0, tokenExpired: 0 });
  });

  it("marks a real uninstall alongside a dormant shop (the dormant one is untouched)", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: EXPIRED },
      { id: "s2", domain: "dead.myshopify.com" },
      { id: "s3", domain: "live.myshopify.com" },
    ]);
    sessionsFor([
      [EXPIRED, PAST],
      ["dead.myshopify.com", FUTURE],
      ["live.myshopify.com", FUTURE],
    ]);
    mockAdmin.mockImplementation(async (domain: string) =>
      domain === "dead.myshopify.com"
        ? adminGraphql(async () => {
            throw { response: { code: 401 } };
          })
        : adminGraphql(async () => ({ status: 200 })),
    );

    const result = await runReconcile();

    expect(mockAdmin).not.toHaveBeenCalledWith(EXPIRED);
    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(mockMark).toHaveBeenCalledWith("dead.myshopify.com", expect.anything());
    expect(result).toMatchObject({ checked: 3, marked: 1, skipped: 0, tokenExpired: 1 });
  });

  // Changed on purpose (re-audit #1): a token_expired outcome can never be
  // marked, so it is EXCLUDED from the breaker's probed base (it only diluted
  // it). Here 1 dormant + 2 classified uninstalled of 3: probed = 2 and 2 of 2
  // would mark, the systemic signature: abort and mark NOTHING.
  it("excludes token_expired outcomes from the probed base (3 active, 1 dormant, 2 uninstalled): trips", async () => {
    mockFindMany.mockResolvedValue([
      { id: "s1", domain: EXPIRED },
      { id: "s2", domain: "dead1.myshopify.com" },
      { id: "s3", domain: "dead2.myshopify.com" },
    ]);
    sessionsFor([[EXPIRED, PAST]]);
    maskedWithUnrecognized401();
    mockAdmin.mockResolvedValue(
      adminGraphql(async () => {
        throw { response: { code: 401 } };
      }),
    );

    const result = await runReconcile();

    expect(mockMark).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "aborted-circuit-breaker", checked: 3, wouldMark: 2 });
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        metadata: expect.objectContaining({ checked: 3, probed: 2, tokenExpired: 1, wouldMark: 2 }),
      }),
    );
  });

  it("a 404 expired-token shop stays in probed AND wouldMark (it is markable)", async () => {
    // 4 active: 1 expired-token shop whose store is gone (404) + 3 live.
    mockFindMany.mockResolvedValue([
      { id: "s0", domain: EXPIRED },
      { id: "s1", domain: "live1.myshopify.com" },
      { id: "s2", domain: "live2.myshopify.com" },
      { id: "s3", domain: "live3.myshopify.com" },
    ]);
    sessionsFor([[EXPIRED, PAST]]);
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    mockAdmin.mockResolvedValue(adminGraphql(async () => ({ status: 200 })));

    const result = await runReconcile();

    // probed = 4, wouldMark = 1 < threshold 3: marked, not paged.
    expect(mockMark).toHaveBeenCalledWith(EXPIRED, expect.anything());
    expect(result).toMatchObject({ status: "completed", checked: 4, marked: 1, tokenExpired: 0 });
  });

  describe("dormant shops can never dilute the breaker", () => {
    /** `live` active shops (the first `dead` of them 401) plus `dormant` expired-token shops. */
    function base(live: number, dead: number, dormant: number) {
      const liveDomains = Array.from({ length: live }, (_, i) => `live${i}.myshopify.com`);
      const dormantDomains = Array.from({ length: dormant }, (_, i) => `dormant${i}.myshopify.com`);
      mockFindMany.mockResolvedValue(
        [...liveDomains, ...dormantDomains].map((domain, i) => ({ id: `s${i}`, domain })),
      );
      sessionsFor(dormantDomains.map((d) => [d, PAST]));
      maskedWithUnrecognized401(); // every dormant shop's raw refresh: 401, unknown body
      const deadSet = new Set(liveDomains.slice(0, dead));
      mockAdmin.mockImplementation(async (domain: string) =>
        deadSet.has(domain)
          ? adminGraphql(async () => {
              throw { response: { code: 401 } };
            })
          : adminGraphql(async () => ({ status: 200 })),
      );
    }

    it("12 active + 13 dormant, a fault marking ALL 12 active: TRIPS (probed 12, not 25)", async () => {
      base(12, 12, 13);

      const result = await runReconcile();

      expect(mockMark).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "aborted-circuit-breaker",
        checked: 25,
        wouldMark: 12,
      });
      expect(mockRecordOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "reconcile_aborted",
          metadata: {
            checked: 25,
            probed: 12,
            skipped: 0,
            tokenExpired: 13,
            wouldMark: 12,
            threshold: 6,
          },
        }),
      );
    });

    it("2 active + 5 dormant, both active classified uninstalled: TRIPS", async () => {
      base(2, 2, 5);

      const result = await runReconcile();

      expect(mockMark).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: "aborted-circuit-breaker", checked: 7, wouldMark: 2 });
    });

    it("12 active + 1 dormant, an ordinary day: nothing marked, no page", async () => {
      base(12, 0, 1);

      const result = await runReconcile();

      expect(result).toMatchObject({
        status: "completed",
        checked: 13,
        marked: 0,
        skipped: 0,
        tokenExpired: 1,
      });
      expect(mockSendOpsAlert).not.toHaveBeenCalled();
    });

    it("12 active + 1 dormant, 5 real uninstalls: below half of 12 probed, all 5 marked", async () => {
      base(12, 5, 1);

      const result = await runReconcile();

      expect(result).toMatchObject({
        status: "completed",
        checked: 13,
        marked: 5,
        tokenExpired: 1,
      });
    });

    it("12 active + 1 dormant, 6 classified uninstalled: trips at half of 12 probed", async () => {
      base(12, 6, 1);

      const result = await runReconcile();

      expect(result).toMatchObject({
        status: "aborted-circuit-breaker",
        checked: 13,
        wouldMark: 6,
      });
      expect(mockMark).not.toHaveBeenCalled();
      expect(mockRecordOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "reconcile_aborted",
          message: expect.stringContaining(
            "6 of 12 probed (13 active, 0 skipped, 1 token-expired)",
          ),
          metadata: {
            checked: 13,
            probed: 12,
            skipped: 0,
            tokenExpired: 1,
            wouldMark: 6,
            threshold: 6,
          },
        }),
      );
    });
  });

  it("replays a get-active-shops result memoized by pre-gc-gre code (no flag) as not expired", async () => {
    const step = createMockInngestStep();
    step.run.mockImplementation((name: string, fn: () => unknown) =>
      name === "get-active-shops" ? [{ id: "s1", domain: EXPIRED }] : fn(),
    );
    mockAdmin.mockResolvedValue(adminGraphql(async () => ({ status: 200 })));

    const result = await getInngestHandler(reconcileInstalls)({ step });

    expect(mockAdmin).toHaveBeenCalledWith(EXPIRED);
    expect(result).toMatchObject({ checked: 1, marked: 0, skipped: 0, tokenExpired: 0 });
  });

  it("skips the session query entirely when there are no active shops", async () => {
    mockFindMany.mockResolvedValue([]);

    await runReconcile();

    expect(mockSessionFindMany).not.toHaveBeenCalled();
  });
});

describe("classifyExpiredTokenRefresh (gc-gre audit fix)", () => {
  it("404 (store gone) is uninstalled", () => {
    expect(classifyExpiredTokenRefresh(404)).toBe("uninstalled");
  });

  it.each([200, 400, 401, 403, 429, 500, 503, null])(
    "%s is token_expired (never marked)",
    (status) => {
      expect(classifyExpiredTokenRefresh(status)).toBe("token_expired");
    },
  );
});
