/**
 * Tests for app/routes/app.admin.submissions.tsx (admin submission review).
 *
 * Strategy:
 *   - Mock authenticate.admin() to control session.
 *   - Mock getShopMetadata and isAdminShop to control the admin gate.
 *   - Mock the unknown-script model functions.
 *   - Test loader: admin allowed (data shapes), admin denied (403), missing shop.
 *   - Test action: acceptDomain calls acceptSubmissionsForDomain; updateStatus
 *     calls updateSubmissionStatus with the right status; validation; 403 gate.
 */

import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: {},
}));

vi.mock("../../app/models/shop.server", () => ({
  getShopMetadata: vi.fn(),
}));

vi.mock("../../app/lib/admin-gate.server", () => ({
  isAdminShop: vi.fn(),
}));

vi.mock("../../app/models/unknown-script.server", () => ({
  getSubmissionStats: vi.fn(),
  getSubmissionsByDomain: vi.fn(),
  listSubmissionsForReview: vi.fn(),
  acceptSubmissionsForDomain: vi.fn(),
  updateSubmissionStatus: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../app/lib/format", () => ({
  formatDate: vi.fn().mockReturnValue("Apr 1, 2026"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { isAdminShop } from "../../app/lib/admin-gate.server";
import { getShopMetadata } from "../../app/models/shop.server";
import {
  getSubmissionStats,
  getSubmissionsByDomain,
  listSubmissionsForReview,
  acceptSubmissionsForDomain,
  updateSubmissionStatus,
} from "../../app/models/unknown-script.server";
import { loader, action } from "../../app/routes/app.admin.submissions";
import { authenticate } from "../../app/shopify.server";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopMetadata = getShopMetadata as ReturnType<typeof vi.fn>;
const mockIsAdminShop = isAdminShop as ReturnType<typeof vi.fn>;
const mockGetSubmissionStats = getSubmissionStats as ReturnType<typeof vi.fn>;
const mockGetSubmissionsByDomain = getSubmissionsByDomain as ReturnType<typeof vi.fn>;
const mockListSubmissionsForReview = listSubmissionsForReview as ReturnType<typeof vi.fn>;
const mockAcceptSubmissionsForDomain = acceptSubmissionsForDomain as ReturnType<typeof vi.fn>;
const mockUpdateSubmissionStatus = updateSubmissionStatus as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SHOP = {
  id: "shop-1",
  domain: "admin.myshopify.com",
  plan: "professional",
  installedAt: new Date(),
  lastThemePublishAt: null,
  hasSeenReviewPrompt: false,
};

const SAMPLE_STATS = { total: 10, pending: 4, accepted: 5, rejected: 1 };

const SAMPLE_DOMAIN_GROUP = {
  domain: "cdn.example.com",
  submissionCount: 3,
  suggestedNames: [{ name: "Example App", count: 3 }],
  sampleUrls: ["https://cdn.example.com/a.js"],
};

const SAMPLE_SUBMISSION = {
  id: "sub-1",
  suggestedAppName: "Example App",
  status: "PENDING" as const,
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  reviewedAt: null,
  url: "https://cdn.example.com/a.js",
  filename: "layout/theme.liquid",
  domain: "cdn.example.com",
};

function makeRequest(method = "GET", body?: URLSearchParams) {
  return new Request("https://app.alpenglowsoftware.com/app/admin/submissions", {
    method,
    ...(body
      ? {
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Setup defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockAuthenticateAdmin.mockResolvedValue({ session: { shop: "admin.myshopify.com" } });
  mockGetShopMetadata.mockResolvedValue(SAMPLE_SHOP);
  mockIsAdminShop.mockReturnValue(true);
  mockGetSubmissionStats.mockResolvedValue(SAMPLE_STATS);
  mockGetSubmissionsByDomain.mockResolvedValue([SAMPLE_DOMAIN_GROUP]);
  mockListSubmissionsForReview.mockResolvedValue([SAMPLE_SUBMISSION]);
});

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------

describe("loader — admin allowed", () => {
  it("returns stats, domain groups, and pending submissions", async () => {
    const result = await loader({ request: makeRequest() } as LoaderFunctionArgs);

    expect(result.shopDomain).toBe("admin.myshopify.com");
    expect(result.stats).toEqual(SAMPLE_STATS);
    expect(result.domainGroups).toEqual([SAMPLE_DOMAIN_GROUP]);
    expect(result.pendingSubmissions).toEqual([SAMPLE_SUBMISSION]);
  });

  it("requests only PENDING submissions for both grouped and flat lists", async () => {
    await loader({ request: makeRequest() } as LoaderFunctionArgs);

    expect(mockGetSubmissionsByDomain).toHaveBeenCalledWith({ status: "PENDING" });
    expect(mockListSubmissionsForReview).toHaveBeenCalledWith({ status: "PENDING" });
  });
});

describe("loader — admin denied", () => {
  it("throws 403 when isAdminShop returns false", async () => {
    mockIsAdminShop.mockReturnValue(false);

    await expect(loader({ request: makeRequest() } as LoaderFunctionArgs)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("throws 403 when shop is not found in DB", async () => {
    mockGetShopMetadata.mockResolvedValue(null);

    await expect(loader({ request: makeRequest() } as LoaderFunctionArgs)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("does not query submissions when denied", async () => {
    mockIsAdminShop.mockReturnValue(false);

    try {
      await loader({ request: makeRequest() } as LoaderFunctionArgs);
    } catch {
      // Expected 403
    }

    expect(mockGetSubmissionStats).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action tests — acceptDomain
// ---------------------------------------------------------------------------

describe("action — acceptDomain", () => {
  it("calls acceptSubmissionsForDomain with the posted domain", async () => {
    mockAcceptSubmissionsForDomain.mockResolvedValue({ count: 3 });
    const body = new URLSearchParams({ intent: "acceptDomain", domain: "cdn.example.com" });

    const result = await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);

    expect(mockAcceptSubmissionsForDomain).toHaveBeenCalledWith("cdn.example.com");
    expect(result).toEqual({ ok: true, accepted: 3 });
  });

  it("returns an error when domain is missing", async () => {
    const body = new URLSearchParams({ intent: "acceptDomain" });

    const result = await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);

    expect(result).toEqual({ error: "Domain is required" });
    expect(mockAcceptSubmissionsForDomain).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action tests — updateStatus
// ---------------------------------------------------------------------------

describe("action — updateStatus", () => {
  it("calls updateSubmissionStatus with ACCEPTED", async () => {
    mockUpdateSubmissionStatus.mockResolvedValue({ id: "sub-1", status: "ACCEPTED" });
    const body = new URLSearchParams({
      intent: "updateStatus",
      submissionId: "sub-1",
      status: "ACCEPTED",
    });

    const result = await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);

    expect(mockUpdateSubmissionStatus).toHaveBeenCalledWith("sub-1", "ACCEPTED");
    expect(result).toEqual({ ok: true });
  });

  it("calls updateSubmissionStatus with REJECTED", async () => {
    mockUpdateSubmissionStatus.mockResolvedValue({ id: "sub-1", status: "REJECTED" });
    const body = new URLSearchParams({
      intent: "updateStatus",
      submissionId: "sub-1",
      status: "REJECTED",
    });

    await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);

    expect(mockUpdateSubmissionStatus).toHaveBeenCalledWith("sub-1", "REJECTED");
  });

  it("rejects an invalid status without calling the model", async () => {
    const body = new URLSearchParams({
      intent: "updateStatus",
      submissionId: "sub-1",
      status: "PENDING",
    });

    const result = await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);

    expect(result).toEqual({ error: "Invalid status" });
    expect(mockUpdateSubmissionStatus).not.toHaveBeenCalled();
  });

  it("returns an error when submissionId is missing", async () => {
    const body = new URLSearchParams({ intent: "updateStatus", status: "ACCEPTED" });

    const result = await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);

    expect(result).toEqual({ error: "Submission id is required" });
    expect(mockUpdateSubmissionStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action tests — gate + unknown intent
// ---------------------------------------------------------------------------

describe("action — admin denied", () => {
  it("throws 403 when isAdminShop returns false", async () => {
    mockIsAdminShop.mockReturnValue(false);
    const body = new URLSearchParams({ intent: "acceptDomain", domain: "cdn.example.com" });

    await expect(
      action({ request: makeRequest("POST", body) } as ActionFunctionArgs),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("does not mutate when denied", async () => {
    mockIsAdminShop.mockReturnValue(false);
    const body = new URLSearchParams({ intent: "acceptDomain", domain: "cdn.example.com" });

    try {
      await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);
    } catch {
      // Expected 403
    }

    expect(mockAcceptSubmissionsForDomain).not.toHaveBeenCalled();
  });
});

describe("action — unknown intent", () => {
  it("returns an error for an unrecognized intent", async () => {
    const body = new URLSearchParams({ intent: "bogus" });

    const result = await action({ request: makeRequest("POST", body) } as ActionFunctionArgs);

    expect(result).toEqual({ error: "Unknown action" });
  });
});
