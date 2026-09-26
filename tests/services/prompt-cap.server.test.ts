/**
 * Tests for app/services/prompt-cap.server.ts (gc-97k.6): resolvePrompt with
 * the REAL claimPromptSlot / getShopMetadata (shop model) against a mocked
 * Prisma client, so the conditional-update claim and the lost-claim re-read are
 * exercised end to end. Includes a concurrency test against an in-memory row
 * that honors updateMany's compare-and-set semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  shop: { updateMany: vi.fn(), findUnique: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

const mockLoggerError = vi.fn();
vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { PROMPT_CAP_WINDOW_MS } from "../../app/lib/prompt-cap";
import type { PromptKey } from "../../app/lib/prompt-cap";
import { resolvePrompt } from "../../app/services/prompt-cap.server";

const DOMAIN = "merchant.myshopify.com";
const NOW = new Date("2026-09-26T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const FRESH = { lastPromptKey: null, lastPromptShownAt: null };

function input(
  eligible: PromptKey[],
  state: { lastPromptKey: string | null; lastPromptShownAt: Date | null } = FRESH,
) {
  return { shopDomain: DOMAIN, eligible, now: NOW, ...state };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolvePrompt", () => {
  it("nothing eligible: null and no write", async () => {
    await expect(resolvePrompt(input([]))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("cap blocks a different prompt: null and no write", async () => {
    const state = { lastPromptKey: "feedback", lastPromptShownAt: ago(HOUR) };
    await expect(resolvePrompt(input(["review_banner"], state))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("same prompt inside its window: renders with no write (window not extended)", async () => {
    const state = { lastPromptKey: "feedback", lastPromptShownAt: ago(HOUR) };
    await expect(resolvePrompt(input(["feedback"], state))).resolves.toBe("feedback");
    expect(mockDb.shop.updateMany).not.toHaveBeenCalled();
  });

  it("a new pick claims the slot keyed on the previous state it read", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(resolvePrompt(input(["review_banner", "feedback"]))).resolves.toBe("feedback");

    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: DOMAIN, lastPromptKey: null, lastPromptShownAt: null },
      data: { lastPromptKey: "feedback", lastPromptShownAt: NOW },
    });
    expect(mockDb.shop.findUnique).not.toHaveBeenCalled();
  });

  it("an expired window re-claims (same key) keyed on the old timestamp", async () => {
    const old = ago(PROMPT_CAP_WINDOW_MS);
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      resolvePrompt(input(["feedback"], { lastPromptKey: "feedback", lastPromptShownAt: old })),
    ).resolves.toBe("feedback");

    expect(mockDb.shop.updateMany).toHaveBeenCalledWith({
      where: { domain: DOMAIN, lastPromptKey: "feedback", lastPromptShownAt: old },
      data: { lastPromptKey: "feedback", lastPromptShownAt: NOW },
    });
  });

  it("lost claim, winner took the SAME prompt: renders it without a second write", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce({
      lastPromptKey: "feedback",
      lastPromptShownAt: NOW,
    });

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBe("feedback");
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lost claim, winner took a DIFFERENT prompt: renders nothing", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce({
      lastPromptKey: "review_popup",
      lastPromptShownAt: NOW,
    });

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lost claim and the re-read state still needs a claim: renders nothing (no retry loop)", async () => {
    // e.g. the row changed back to an expired state between the claim and the re-read.
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce({
      lastPromptKey: "feedback",
      lastPromptShownAt: ago(2 * PROMPT_CAP_WINDOW_MS),
    });

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockDb.shop.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lost claim because the shop row is gone: null", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockResolvedValueOnce(null);

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
  });

  it("never throws: a failed claim logs and fails closed (null)", async () => {
    mockDb.shop.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockLoggerError).toHaveBeenCalledWith("prompt-cap-claim-failed", {
      shop: DOMAIN,
      prompt: "feedback",
      error: "db down",
    });
  });

  it("never throws: a failed re-read after a lost claim logs and fails closed", async () => {
    mockDb.shop.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.shop.findUnique.mockRejectedValueOnce(new Error("read failed"));

    await expect(resolvePrompt(input(["feedback"]))).resolves.toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePrompt: concurrency", () => {
  /**
   * One in-memory Shop row. updateMany applies its data only when every where
   * field still matches (Postgres row-level compare-and-set), and each call
   * yields first so both loads read before either writes.
   */
  function installRow(initial: { lastPromptKey: string | null; lastPromptShownAt: Date | null }) {
    const row = { domain: DOMAIN, ...initial };
    mockDb.shop.updateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<typeof row> }) => {
        await Promise.resolve();
        const matches = Object.entries(where).every(([k, v]) => {
          const current = row[k as keyof typeof row];
          if (v instanceof Date && current instanceof Date) {
            return v.getTime() === current.getTime();
          }
          return v === current;
        });
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    );
    mockDb.shop.findUnique.mockImplementation(async () => ({ ...row }));
    return row;
  }

  it("two loads that read the same state cannot both claim different prompts", async () => {
    const row = installRow(FRESH);

    // Load A (e.g. scan results) sees review_popup eligible; load B (home) sees
    // only feedback. Both read the same fresh state before either writes.
    const [a, b] = await Promise.all([
      resolvePrompt(input(["review_popup"])),
      resolvePrompt(input(["feedback"])),
    ]);

    const rendered = [a, b].filter((p) => p !== null);
    expect(rendered).toHaveLength(1);
    expect(row.lastPromptKey).toBe(rendered[0]);
    expect(row.lastPromptShownAt).toEqual(NOW);
  });

  it("two loads claiming the SAME prompt both render it, with one write winning", async () => {
    const row = installRow(FRESH);

    const [a, b] = await Promise.all([
      resolvePrompt(input(["feedback"])),
      resolvePrompt(input(["feedback"])),
    ]);

    expect([a, b]).toEqual(["feedback", "feedback"]);
    expect(row.lastPromptKey).toBe("feedback");
  });
});
