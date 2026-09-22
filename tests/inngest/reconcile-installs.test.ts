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
  default: { shop: { findMany: vi.fn() } },
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

  // --- Masked-failure disambiguation via rawRefreshProbe ------------------
  // The library masks a real 401/404 refresh rejection as `new Response(500)`,
  // so unauthenticated.admin throws a 500 wrapper. The reconciler must re-probe
  // Shopify's raw refresh endpoint to disambiguate installed vs uninstalled.

  it("masked-500 + raw refresh 401 WITH a refresh-token error body → MARKED uninstalled (source=reconciler)", async () => {
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "expired401.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
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
    expect(result).toMatchObject({ checked: 1, marked: 1, skipped: 0 });
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
    mockFindMany.mockResolvedValue([{ id: "s1", domain: "closed404.myshopify.com" }]);
    mockAdmin.mockRejectedValue(maskedAdminFailure());
    mockLoadSession.mockResolvedValue(fakeOfflineSession());
    mockFetch.mockResolvedValue({ status: 404, json: async () => ({}) });

    const result = await runReconcile();

    expect(mockMark).toHaveBeenCalledWith(
      "closed404.myshopify.com",
      expect.objectContaining({ source: "reconciler" }),
    );
    expect(result).toMatchObject({ checked: 1, marked: 1, skipped: 0 });
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
    // produced 401s across the base). threshold = max(5, ceil(0.5*12)=6) = 6,
    // so 12 > 6 trips the breaker: nothing is marked, the operator is paged.
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
    // An abort OpsEvent was recorded (counts-only metadata; domains in message).
    expect(mockRecordOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "reconcile_aborted",
        key: "reconcile-installs",
        message: expect.stringContaining("ABORTED by circuit breaker"),
        metadata: { checked: 12, wouldMark: 12, threshold: 6 },
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
    // 8 shops, 3 uninstalled, 5 installed. threshold = max(5, ceil(0.5*8)=4) = 5,
    // so 3 <= 5: the breaker stays closed and the 3 real uninstalls are marked.
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
        metadata: { checked: 8, marked: 3, skipped: 0 },
      }),
    );
    expect(result).toMatchObject({ status: "completed", checked: 8, marked: 3, skipped: 0 });
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
