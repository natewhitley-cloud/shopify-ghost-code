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
    deleteMany: vi.fn(),
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
  // $transaction supports both the interactive (callback) and array forms.
  // createUnknownScripts uses the interactive form: pass a tx-scoped client to
  // the callback so the inner awaits execute against the same mockDb.
  $transaction: vi.fn(
    async (arg: ((tx: typeof mockDb) => Promise<unknown>) | Promise<unknown>[]) => {
      if (typeof arg === "function") {
        return arg(mockDb);
      }
      return Promise.all(arg);
    },
  ),
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
  listSubmissionsForReview,
  SUBMISSION_QUERY_LIMIT,
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

  it("bounds the read with a take limit and orders newest first", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([]);

    await getSubmissionsByDomain();

    expect(mockDb.signatureSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: SUBMISSION_QUERY_LIMIT,
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(SUBMISSION_QUERY_LIMIT).toBeGreaterThan(0);
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

  it("accepts indexed rows via an exact domain-column match (fast path)", async () => {
    // Fast path: the first findMany queries the indexed `domain` column and its
    // rows are exact matches used directly (no JS refine). The second findMany
    // (legacy null-domain fallback) returns nothing here.
    mockDb.unknownScript.findMany
      .mockResolvedValueOnce([{ id: "us-1" }, { id: "us-2" }])
      .mockResolvedValueOnce([]);
    mockDb.signatureSubmission.updateMany.mockResolvedValue({ count: 4 });

    const result = await acceptSubmissionsForDomain("target.com");

    // First query hits the indexed column with an exact equality.
    expect(mockDb.unknownScript.findMany).toHaveBeenNthCalledWith(1, {
      where: { domain: "target.com" },
      select: { id: true },
    });
    // Second query is the legacy fallback, scoped to null-domain rows only.
    expect(mockDb.unknownScript.findMany).toHaveBeenNthCalledWith(2, {
      where: { domain: null, url: { contains: "target.com" } },
      select: { id: true, url: true },
    });
    expect(mockDb.signatureSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        unknownScriptId: { in: ["us-1", "us-2"] },
        status: { not: "REJECTED" },
      },
      data: { status: "ACCEPTED", reviewedAt: expect.any(Date) },
    });
    expect(result).toEqual({ count: 4 });
  });

  it("matches legacy null-domain rows via contains + JS hostname refine", async () => {
    // No indexed rows; legacy fallback returns a real match plus a substring
    // false-positive ("nottarget.com" contains "target.com") that the JS
    // hostname refine must drop.
    mockDb.unknownScript.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "us-3", url: "https://target.com/c.js" },
      { id: "us-4", url: "https://nottarget.com/d.js" },
    ]);
    mockDb.signatureSubmission.updateMany.mockResolvedValue({ count: 1 });

    const result = await acceptSubmissionsForDomain("target.com");

    expect(mockDb.signatureSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        unknownScriptId: { in: ["us-3"] },
        status: { not: "REJECTED" },
      },
      data: { status: "ACCEPTED", reviewedAt: expect.any(Date) },
    });
    expect(result).toEqual({ count: 1 });
  });

  it("combines indexed and legacy matches into one update", async () => {
    mockDb.unknownScript.findMany
      .mockResolvedValueOnce([{ id: "us-1" }])
      .mockResolvedValueOnce([{ id: "us-2", url: "https://target.com/b.js" }]);
    mockDb.signatureSubmission.updateMany.mockResolvedValue({ count: 2 });

    await acceptSubmissionsForDomain("target.com");

    expect(mockDb.signatureSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        unknownScriptId: { in: ["us-1", "us-2"] },
        status: { not: "REJECTED" },
      },
      data: { status: "ACCEPTED", reviewedAt: expect.any(Date) },
    });
  });

  it("guards the update with status not REJECTED so prior rejections are preserved (gc-06e.10)", async () => {
    // A submission an operator explicitly REJECTED for this domain must NOT be
    // flipped back to ACCEPTED on a later "Accept domain" click. The updateMany
    // where clause therefore excludes REJECTED rows — only PENDING (and already
    // ACCEPTED) rows are targeted.
    mockDb.unknownScript.findMany.mockResolvedValueOnce([{ id: "us-1" }]).mockResolvedValueOnce([]);
    mockDb.signatureSubmission.updateMany.mockResolvedValue({ count: 1 });

    await acceptSubmissionsForDomain("target.com");

    expect(mockDb.signatureSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: "REJECTED" } }),
      }),
    );
  });

  it("returns count 0 and skips the update when nothing matches", async () => {
    mockDb.unknownScript.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await acceptSubmissionsForDomain("target.com");

    expect(result).toEqual({ count: 0 });
    expect(mockDb.signatureSubmission.updateMany).not.toHaveBeenCalled();
  });

  it("propagates a database error", async () => {
    mockDb.unknownScript.findMany.mockRejectedValue(new Error("Connection timeout"));

    await expect(acceptSubmissionsForDomain("target.com")).rejects.toThrow("Connection timeout");
  });
});

// ---------------------------------------------------------------------------
// listSubmissionsForReview
// ---------------------------------------------------------------------------

describe("listSubmissionsForReview", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns flattened review rows with unknown-script context", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([
      {
        id: "sub-1",
        suggestedAppName: "Klaviyo",
        status: "PENDING",
        createdAt: new Date("2026-01-15T10:00:00Z"),
        reviewedAt: null,
        unknownScript: {
          url: "https://cdn.klaviyo.com/a.js",
          filename: "layout/theme.liquid",
          domain: "cdn.klaviyo.com",
        },
      },
    ]);

    const result = await listSubmissionsForReview({ status: "PENDING" });

    expect(result).toEqual([
      {
        id: "sub-1",
        suggestedAppName: "Klaviyo",
        status: "PENDING",
        createdAt: new Date("2026-01-15T10:00:00Z"),
        reviewedAt: null,
        url: "https://cdn.klaviyo.com/a.js",
        filename: "layout/theme.liquid",
        domain: "cdn.klaviyo.com",
      },
    ]);
  });

  it("filters by status and bounds the read with take + newest-first order", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([]);

    await listSubmissionsForReview({ status: "PENDING" });

    expect(mockDb.signatureSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "PENDING" },
        take: SUBMISSION_QUERY_LIMIT,
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("passes no where clause when status is not provided", async () => {
    mockDb.signatureSubmission.findMany.mockResolvedValue([]);

    await listSubmissionsForReview();

    expect(mockDb.signatureSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
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

  it("clears stale rows on empty input without calling createMany", async () => {
    // Idempotency guard: even with no scripts, the deleteMany must run so a
    // retry carrying zero scripts clears rows left by a prior partial attempt.
    mockDb.unknownScript.deleteMany.mockResolvedValue({ count: 0 });

    const result = await createUnknownScripts("scan-1", []);

    expect(result).toEqual({ count: 0 });
    expect(mockDb.unknownScript.deleteMany).toHaveBeenCalledWith({ where: { scanId: "scan-1" } });
    expect(mockDb.unknownScript.createMany).not.toHaveBeenCalled();
  });

  it("deletes existing rows before inserting (idempotency guard)", async () => {
    mockDb.unknownScript.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.unknownScript.createMany.mockResolvedValue({ count: 1 });

    await createUnknownScripts("scan-7", [makeScript()]);

    // Both writes go through $transaction, and deleteMany precedes createMany.
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
    expect(mockDb.unknownScript.deleteMany).toHaveBeenCalledWith({ where: { scanId: "scan-7" } });
    const deleteOrder = mockDb.unknownScript.deleteMany.mock.invocationCallOrder[0];
    const createOrder = mockDb.unknownScript.createMany.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it("stamps each record with the scanId and calls createMany", async () => {
    mockDb.unknownScript.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.unknownScript.createMany.mockResolvedValue({ count: 2 });
    const scripts = [
      makeScript({ filename: "a.liquid", lineNumber: 1 }),
      makeScript({ filename: "b.liquid", lineNumber: 2 }),
    ];

    const result = await createUnknownScripts("scan-99", scripts);

    expect(mockDb.unknownScript.createMany).toHaveBeenCalledWith({
      data: [
        { ...scripts[0], scanId: "scan-99", domain: "cdn.example.com" },
        { ...scripts[1], scanId: "scan-99", domain: "cdn.example.com" },
      ],
    });
    expect(result).toEqual({ count: 2 });
  });

  it("does not duplicate rows when called twice with the same scanId + scripts (Inngest retry regression)", async () => {
    // Regression for LOG-14 / GC-mus: the Inngest fetch-and-scan step re-runs the
    // whole step on retry. A bare createMany inserted a second copy of every row.
    // Simulate persistent DB state across two identical calls and assert the row
    // set is unchanged after the second call (deleteMany clears, createMany re-adds).
    const scripts = [
      makeScript({ filename: "a.liquid", lineNumber: 1 }),
      makeScript({ filename: "b.liquid", lineNumber: 2 }),
    ];

    let stored: Array<CreateUnknownScriptInput & { scanId: string }> = [];
    mockDb.unknownScript.deleteMany.mockImplementation(async ({ where }) => {
      const before = stored.length;
      stored = stored.filter((row) => row.scanId !== where.scanId);
      return { count: before - stored.length };
    });
    mockDb.unknownScript.createMany.mockImplementation(async ({ data }) => {
      stored.push(...data);
      return { count: data.length };
    });

    await createUnknownScripts("scan-retry", scripts);
    expect(stored).toHaveLength(2);

    // Step retry: identical inputs run again.
    await createUnknownScripts("scan-retry", scripts);

    // Exactly one copy survives — not four.
    expect(stored).toHaveLength(2);
    expect(stored.filter((r) => r.scanId === "scan-retry")).toHaveLength(2);
  });

  it("propagates a database error", async () => {
    mockDb.unknownScript.deleteMany.mockResolvedValue({ count: 0 });
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
