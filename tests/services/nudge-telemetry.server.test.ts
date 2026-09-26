/**
 * Tests for app/services/nudge-telemetry.server.ts (gc-97k.1)
 *
 * Strategy:
 *   - Mock db.server so the REAL recordOpsEvent runs against a spy create().
 *   - Each emitter must write its own eventType, key = the shop DOMAIN (what
 *     deleteShopData purges by), and metadata.nudgeKey.
 *   - A failed write must resolve (never throw into a loader) and log a warn.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  opsEvent: { create: vi.fn() },
}));

vi.mock("../../app/db.server", () => ({ default: mockDb }));

const mockLoggerWarn = vi.fn();
vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

import {
  NUDGE_FUNNEL_EVENT_TYPES,
  NUDGE_RETENTION_DAYS,
  OPS_EVENT_TYPES,
} from "../../app/models/ops-event.server";
import {
  NUDGE_KEYS,
  recordNudgeClicked,
  recordNudgeConverted,
  recordNudgeDismissed,
  recordNudgeNotShown,
  recordNudgeShown,
} from "../../app/services/nudge-telemetry.server";

const DOMAIN = "merchant.myshopify.com";

const EMITTERS = [
  { name: "recordNudgeShown", fn: recordNudgeShown, eventType: "nudge_shown" },
  { name: "recordNudgeClicked", fn: recordNudgeClicked, eventType: "nudge_clicked" },
  { name: "recordNudgeDismissed", fn: recordNudgeDismissed, eventType: "nudge_dismissed" },
  { name: "recordNudgeConverted", fn: recordNudgeConverted, eventType: "nudge_converted" },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.opsEvent.create.mockResolvedValue({ id: "e1" });
});

describe("nudge constants", () => {
  it("exposes the two planned nudge keys with stable string values", () => {
    expect(NUDGE_KEYS).toEqual({
      UPGRADE_PREVIEW: "upgrade_preview",
      FEEDBACK: "feedback",
      REVIEW_REQUEST: "review_request",
    });
  });

  it("uses stable event type strings (the digest and prune read these; do not rename)", () => {
    expect(OPS_EVENT_TYPES.NUDGE_SHOWN).toBe("nudge_shown");
    expect(OPS_EVENT_TYPES.NUDGE_CLICKED).toBe("nudge_clicked");
    expect(OPS_EVENT_TYPES.NUDGE_DISMISSED).toBe("nudge_dismissed");
    expect(OPS_EVENT_TYPES.NUDGE_CONVERTED).toBe("nudge_converted");
    expect(OPS_EVENT_TYPES.NUDGE_NOT_SHOWN).toBe("nudge_not_shown");
    expect([...NUDGE_FUNNEL_EVENT_TYPES]).toEqual([
      "nudge_shown",
      "nudge_clicked",
      "nudge_dismissed",
      "nudge_converted",
      "nudge_not_shown",
    ]);
  });

  it("retains nudge rows for 90 days", () => {
    expect(NUDGE_RETENTION_DAYS).toBe(90);
  });
});

describe.each(EMITTERS)("$name", ({ fn, eventType }) => {
  it("writes one row: its eventType, key = shop domain, metadata.nudgeKey", async () => {
    await fn(NUDGE_KEYS.UPGRADE_PREVIEW, DOMAIN);

    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
    expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
      data: {
        eventType,
        key: DOMAIN,
        message: null,
        metadata: { nudgeKey: "upgrade_preview" },
      },
    });
  });

  it("carries the nudgeKey it was given (feedback)", async () => {
    await fn(NUDGE_KEYS.FEEDBACK, DOMAIN);

    expect(mockDb.opsEvent.create.mock.calls[0][0].data.metadata).toEqual({
      nudgeKey: "feedback",
    });
  });

  it("passes the domain through unmodified (the redact clause matches it exactly)", async () => {
    await fn(NUDGE_KEYS.FEEDBACK, "Mixed-Case.myshopify.com");

    expect(mockDb.opsEvent.create.mock.calls[0][0].data.key).toBe("Mixed-Case.myshopify.com");
  });

  it("never throws when the write fails: resolves and logs a warn", async () => {
    mockDb.opsEvent.create.mockRejectedValue(new Error("db down"));

    await expect(fn(NUDGE_KEYS.UPGRADE_PREVIEW, DOMAIN)).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "ops-event-record-failed",
      expect.objectContaining({ eventType, key: DOMAIN, error: "db down" }),
    );
  });

  it("never throws on a non-Error rejection either", async () => {
    mockDb.opsEvent.create.mockRejectedValue("string failure");

    await expect(fn(NUDGE_KEYS.FEEDBACK, DOMAIN)).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });
});

describe("recordNudgeNotShown (gc-97k.7)", () => {
  it("writes one nudge_not_shown row carrying the nudgeKey and the reason code", async () => {
    await recordNudgeNotShown(NUDGE_KEYS.REVIEW_REQUEST, DOMAIN, "cooldown-period");

    expect(mockDb.opsEvent.create).toHaveBeenCalledTimes(1);
    expect(mockDb.opsEvent.create).toHaveBeenCalledWith({
      data: {
        eventType: "nudge_not_shown",
        key: DOMAIN,
        message: null,
        metadata: { nudgeKey: "review_request", code: "cooldown-period" },
      },
    });
  });

  it("never throws when the write fails", async () => {
    mockDb.opsEvent.create.mockRejectedValue(new Error("db down"));

    await expect(
      recordNudgeNotShown(NUDGE_KEYS.REVIEW_REQUEST, DOMAIN, "error"),
    ).resolves.toBeUndefined();
  });
});
