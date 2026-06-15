/**
 * Tests for app/models/unknown-script.server.ts
 *
 * Strategy:
 *   - Mock db.server (Prisma client) to control DB responses.
 *   - Test each exported function in isolation.
 *
 * Note on vi.mock hoisting: vi.mock factory functions run before any top-level
 * variable initializations in the test file. Use vi.hoisted() to define mock
 * objects that are referenced inside a vi.mock factory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  unknownScript: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  signatureSubmission: {
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock("../../app/db.server", () => ({
  default: mockDb,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  getSubmissionsByDomain,
  updateSubmissionStatus,
  acceptSubmissionsForDomain,
  getSubmissionStats,
  findUnknownScriptForShop,
  createUnknownScripts,
  submitSignatureSuggestion,
} from "../../app/models/unknown-script.server";
import type { CreateUnknownScriptInput } from "../../app/models/unknown-script.server";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeSubmission(overrides: {
  id?: string;
  suggestedAppName?: string;
  url?: string;
  status?: string;
  unknownScriptId?: string;
}) {
  return {
    id: overrides.id ?? "sub-1",
    unknownScriptId: overrides.unknownScriptId ?? "us-1",
    shopId: "shop-1",
    suggestedAppName: overrides.suggestedAppName ?? "Klaviyo",
    status: overrides.status ?? "PENDING",
    reviewedAt: null,
    createdAt: new Date("2026-01-15T10:00:00Z"),
    unknownScript: {
      url: overrides.url ?? "https://cdn.klaviyo.com/scripts/track.js",
    },
  };
}

// ---------------------------------------------------------------------------
// getSubmissionsByDomain
// ---------------------------------------------------------------------------

describe("getSubmissionsByDomain", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty array when no submissions exist", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([]);

    const result = await getSubmissionsByDomain();

    expect(result).toEqual([]);
  });

  it("groups a single submission into one domain entry", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([
      makeSubmission({ url: "https://cdn.klaviyo.com/scripts/track.js" }),
    ]);

    const result = await getSubmissionsByDomain();

    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("cdn.klaviyo.com");
    expect(result[0].submissionCount).toBe(1);
    expect(result[0].suggestedNames).toEqual([{ name: "Klaviyo", count: 1 }]);
    expect(result[0].sampleUrls).toEqual(["https://cdn.klaviyo.com/scripts/track.js"]);
  });

  it("groups multiple merchants submitting the same domain", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([
      makeSubmission({
        id: "sub-1",
        url: "https://cdn.klaviyo.com/scripts/track.js",
        suggestedAppName: "Klaviyo",
      }),
      makeSubmission({
        id: "sub-2",
        url: "https://cdn.klaviyo.com/scripts/analytics.js",
        suggestedAppName: "Klaviyo",
      }),
      makeSubmission({
        id: "sub-3",
        url: "https://cdn.klaviyo.com/scripts/popup.js",
        suggestedAppName: "Klaviyo Email",
      }),
    ]);

    const result = await getSubmissionsByDomain();

    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("cdn.klaviyo.com");
    expect(result[0].submissionCount).toBe(3);
    expect(result[0].suggestedNames).toEqual([
      { name: "Klaviyo", count: 2 },
      { name: "Klaviyo Email", count: 1 },
    ]);
    // Only 3 sample URLs max
    expect(result[0].sampleUrls).toHaveLength(3);
  });

  it("limits sample URLs to 3 per domain", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([
      makeSubmission({ id: "sub-1", url: "https://example.com/a.js" }),
      makeSubmission({ id: "sub-2", url: "https://example.com/b.js" }),
      makeSubmission({ id: "sub-3", url: "https://example.com/c.js" }),
      makeSubmission({ id: "sub-4", url: "https://example.com/d.js" }),
    ]);

    const result = await getSubmissionsByDomain();

    expect(result[0].sampleUrls).toHaveLength(3);
  });

  it("filters by status when provided", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([]);

    await getSubmissionsByDomain({ status: "ACCEPTED" });

    expect(mockDb.signatureSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "ACCEPTED" },
      }),
    );
  });

  it("passes no where clause when status is not provided", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([]);

    await getSubmissionsByDomain();

    expect(mockDb.signatureSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: undefined,
      }),
    );
  });

  it("filters out domains below minCount threshold", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([
      makeSubmission({
        id: "sub-1",
        url: "https://popular.com/a.js",
        suggestedAppName: "PopularApp",
      }),
      makeSubmission({
        id: "sub-2",
        url: "https://popular.com/b.js",
        suggestedAppName: "PopularApp",
      }),
      makeSubmission({
        id: "sub-3",
        url: "https://rare.com/c.js",
        suggestedAppName: "RareApp",
      }),
    ]);

    const result = await getSubmissionsByDomain({ minCount: 2 });

    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("popular.com");
  });

  it("sorts domains by submission count descending", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([
      makeSubmission({ id: "s1", url: "https://low.com/a.js" }),
      makeSubmission({ id: "s2", url: "https://high.com/a.js" }),
      makeSubmission({ id: "s3", url: "https://high.com/b.js" }),
      makeSubmission({ id: "s4", url: "https://high.com/c.js" }),
      makeSubmission({ id: "s5", url: "https://mid.com/a.js" }),
      makeSubmission({ id: "s6", url: "https://mid.com/b.js" }),
    ]);

    const result = await getSubmissionsByDomain();

    expect(result[0].domain).toBe("high.com");
    expect(result[0].submissionCount).toBe(3);
    expect(result[1].domain).toBe("mid.com");
    expect(result[1].submissionCount).toBe(2);
    expect(result[2].domain).toBe("low.com");
    expect(result[2].submissionCount).toBe(1);
  });

  it("skips submissions with invalid URLs", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([
      makeSubmission({ id: "sub-1", url: "not-a-valid-url" }),
      makeSubmission({
        id: "sub-2",
        url: "https://valid.com/track.js",
        suggestedAppName: "ValidApp",
      }),
    ]);

    const result = await getSubmissionsByDomain();

    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("valid.com");
  });
});

// ---------------------------------------------------------------------------
// updateSubmissionStatus
// ---------------------------------------------------------------------------

describe("updateSubmissionStatus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets status to ACCEPTED and sets reviewedAt", async () => {
    const updated = {
      id: "sub-1",
      status: "ACCEPTED",
      reviewedAt: new Date(),
    };
    mockDb.signatureSubmission.update.mockResolvedValue(updated);

    const result = await updateSubmissionStatus("sub-1", "ACCEPTED");

    expect(mockDb.signatureSubmission.update).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: {
        status: "ACCEPTED",
        reviewedAt: expect.any(Date),
      },
    });
    expect(result).toEqual(updated);
  });

  it("sets status to REJECTED and sets reviewedAt", async () => {
    const updated = {
      id: "sub-2",
      status: "REJECTED",
      reviewedAt: new Date(),
    };
    mockDb.signatureSubmission.update.mockResolvedValue(updated);

    const result = await updateSubmissionStatus("sub-2", "REJECTED");

    expect(mockDb.signatureSubmission.update).toHaveBeenCalledWith({
      where: { id: "sub-2" },
      data: {
        status: "REJECTED",
        reviewedAt: expect.any(Date),
      },
    });
    expect(result).toEqual(updated);
  });

  it("propagates a database error", async () => {
    mockDb.signatureSubmission.update.mockRejectedValue(new Error("Record not found"));

    await expect(updateSubmissionStatus("bad-id", "ACCEPTED")).rejects.toThrow("Record not found");
  });
});

// ---------------------------------------------------------------------------
// acceptSubmissionsForDomain
// ---------------------------------------------------------------------------

describe("acceptSubmissionsForDomain", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("batch-updates submissions for matching domain", async () => {
    mockDb.unknownScript.findMany.mockResolvedValue([
      { id: "us-1", url: "https://target.com/a.js" },
      { id: "us-2", url: "https://target.com/b.js" },
      { id: "us-3", url: "https://other.com/c.js" },
    ]);
    mockDb.signatureSubmission.updateMany.mockResolvedValue({ count: 5 });

    const result = await acceptSubmissionsForDomain("target.com");

    expect(mockDb.signatureSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        unknownScriptId: { in: ["us-1", "us-2"] },
      },
      data: {
        status: "ACCEPTED",
        reviewedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ count: 5 });
  });

  it("returns count 0 when no unknown scripts match the domain", async () => {
    mockDb.unknownScript.findMany.mockResolvedValue([
      { id: "us-1", url: "https://other.com/a.js" },
    ]);

    const result = await acceptSubmissionsForDomain("target.com");

    expect(result).toEqual({ count: 0 });
    expect(mockDb.signatureSubmission.updateMany).not.toHaveBeenCalled();
  });

  it("returns count 0 when there are no unknown scripts at all", async () => {
    mockDb.unknownScript.findMany.mockResolvedValue([]);

    const result = await acceptSubmissionsForDomain("target.com");

    expect(result).toEqual({ count: 0 });
  });

  it("propagates a database error", async () => {
    mockDb.unknownScript.findMany.mockRejectedValue(new Error("Connection timeout"));

    await expect(acceptSubmissionsForDomain("target.com")).rejects.toThrow("Connection timeout");
  });
});

// ---------------------------------------------------------------------------
// getSubmissionStats
// ---------------------------------------------------------------------------

describe("getSubmissionStats", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns correct counts for all statuses", async () => {
    mockDb.signatureSubmission.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(5) // pending
      .mockResolvedValueOnce(3) // accepted
      .mockResolvedValueOnce(2); // rejected

    const stats = await getSubmissionStats();

    expect(stats).toEqual({
      total: 10,
      pending: 5,
      accepted: 3,
      rejected: 2,
    });
  });

  it("calls count with correct filters", async () => {
    mockDb.signatureSubmission.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await getSubmissionStats();

    // First call: total (no where)
    expect(mockDb.signatureSubmission.count).toHaveBeenNthCalledWith(1);
    // Second call: pending
    expect(mockDb.signatureSubmission.count).toHaveBeenNthCalledWith(2, {
      where: { status: "PENDING" },
    });
    // Third call: accepted
    expect(mockDb.signatureSubmission.count).toHaveBeenNthCalledWith(3, {
      where: { status: "ACCEPTED" },
    });
    // Fourth call: rejected
    expect(mockDb.signatureSubmission.count).toHaveBeenNthCalledWith(4, {
      where: { status: "REJECTED" },
    });
  });

  it("returns all zeros when no submissions exist", async () => {
    mockDb.signatureSubmission.count.mockResolvedValue(0);

    const stats = await getSubmissionStats();

    expect(stats).toEqual({
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
    });
  });

  it("propagates a database error", async () => {
    mockDb.signatureSubmission.count.mockRejectedValue(new Error("DB unavailable"));

    await expect(getSubmissionStats()).rejects.toThrow("DB unavailable");
  });
});

// ---------------------------------------------------------------------------
// findUnknownScriptForShop
// ---------------------------------------------------------------------------

describe("findUnknownScriptForShop", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("queries findFirst with the shop-scoped where clause (tenant isolation)", async () => {
    const record = { id: "us-1", scanId: "scan-1", url: "https://cdn.example.com/a.js" };
    mockDb.unknownScript.findFirst.mockResolvedValue(record);

    const result = await findUnknownScriptForShop("us-1", "shop-1");

    // The `scan: { shopId }` filter is the tenant-isolation contract: a script
    // is only returned if its parent scan belongs to the requesting shop.
    expect(mockDb.unknownScript.findFirst).toHaveBeenCalledWith({
      where: { id: "us-1", scan: { shopId: "shop-1" } },
    });
    expect(result).toEqual(record);
  });

  it("returns null when no script matches the id + shop scope", async () => {
    mockDb.unknownScript.findFirst.mockResolvedValue(null);

    const result = await findUnknownScriptForShop("us-missing", "shop-1");

    expect(result).toBeNull();
  });

  it("propagates a database error", async () => {
    mockDb.unknownScript.findFirst.mockRejectedValue(new Error("Connection reset"));

    await expect(findUnknownScriptForShop("us-1", "shop-1")).rejects.toThrow("Connection reset");
  });
});

// ---------------------------------------------------------------------------
// createUnknownScripts
// ---------------------------------------------------------------------------

describe("createUnknownScripts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function makeScript(overrides?: Partial<CreateUnknownScriptInput>): CreateUnknownScriptInput {
    return {
      filename: "layout/theme.liquid",
      lineNumber: 42,
      url: "https://cdn.example.com/widget.js",
      resourceType: "script",
      codeSnippet: '<script src="https://cdn.example.com/widget.js"></script>',
      ...overrides,
    };
  }

  it("short-circuits on empty input without calling createMany", async () => {
    const result = await createUnknownScripts("scan-1", []);

    expect(result).toEqual({ count: 0 });
    expect(mockDb.unknownScript.createMany).not.toHaveBeenCalled();
  });

  it("stamps each record with the scanId and calls createMany", async () => {
    mockDb.unknownScript.createMany.mockResolvedValue({ count: 2 });
    const scripts = [
      makeScript({ filename: "a.liquid", lineNumber: 1 }),
      makeScript({ filename: "b.liquid", lineNumber: 2 }),
    ];

    const result = await createUnknownScripts("scan-99", scripts);

    expect(mockDb.unknownScript.createMany).toHaveBeenCalledWith({
      data: [
        { ...scripts[0], scanId: "scan-99" },
        { ...scripts[1], scanId: "scan-99" },
      ],
    });
    expect(result).toEqual({ count: 2 });
  });

  it("propagates a database error", async () => {
    mockDb.unknownScript.createMany.mockRejectedValue(new Error("Unique constraint"));

    await expect(createUnknownScripts("scan-1", [makeScript()])).rejects.toThrow(
      "Unique constraint",
    );
  });
});

// ---------------------------------------------------------------------------
// submitSignatureSuggestion
// ---------------------------------------------------------------------------

describe("submitSignatureSuggestion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates a signature submission with the provided fields", async () => {
    const created = {
      id: "sub-1",
      unknownScriptId: "us-1",
      shopId: "shop-1",
      suggestedAppName: "Klaviyo",
      status: "PENDING",
    };
    mockDb.signatureSubmission.create.mockResolvedValue(created);

    const result = await submitSignatureSuggestion("us-1", "shop-1", "Klaviyo");

    expect(mockDb.signatureSubmission.create).toHaveBeenCalledWith({
      data: {
        unknownScriptId: "us-1",
        shopId: "shop-1",
        suggestedAppName: "Klaviyo",
      },
    });
    expect(result).toEqual(created);
  });

  it("propagates a database error", async () => {
    mockDb.signatureSubmission.create.mockRejectedValue(new Error("FK violation"));

    await expect(submitSignatureSuggestion("us-1", "shop-1", "Klaviyo")).rejects.toThrow(
      "FK violation",
    );
  });
});
