/**
 * Tests for inngest/functions/snapshot-metrics.ts
 *
 * Strategy:
 *   - Mock computeCurrentMetrics and createMetricSnapshot.
 *   - Mock the Inngest client to capture the handler via getInngestHandler.
 *   - Verify the function computes metrics and stores a snapshot.
 *   - Verify the logger is called with snapshot metadata.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock("../../app/models/metric-snapshot.server", () => ({
  computeCurrentMetrics: vi.fn(),
  createMetricSnapshot: vi.fn(),
}));

vi.mock("../../app/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_config: unknown, _trigger: unknown, handler: (...args: unknown[]) => unknown) => ({
        fn: handler,
      }),
    ),
  },
}));

// Spy the heartbeat write so we can assert the real withCronHeartbeat wrapper
// records a cron_heartbeat after a successful run (without touching the DB).
vi.mock("../../app/models/ops-event.server", () => ({
  recordCronHeartbeat: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { logger } from "../../app/lib/logger.server";
import {
  computeCurrentMetrics,
  createMetricSnapshot,
} from "../../app/models/metric-snapshot.server";
import { recordCronHeartbeat } from "../../app/models/ops-event.server";
import { snapshotMetrics } from "../../inngest/functions/snapshot-metrics";
import { createMockInngestStep, getInngestHandler } from "../mocks/inngest";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockComputeCurrentMetrics = computeCurrentMetrics as ReturnType<typeof vi.fn>;
const mockCreateMetricSnapshot = createMetricSnapshot as ReturnType<typeof vi.fn>;
const mockLoggerInfo = (logger as unknown as { info: ReturnType<typeof vi.fn> }).info;
const mockRecordCronHeartbeat = recordCronHeartbeat as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_DATE = new Date("2026-04-01T00:00:00.000Z");

const SAMPLE_METRICS = {
  snapshotDate: SAMPLE_DATE,
  totalShops: 15,
  activeShops: 10,
  shopsByPlan: { free: 8, professional: 5, business: 2 },
  totalScans: 120,
  scansLast7d: 25,
  scansLast30d: 90,
  completionRate: 0.92,
  totalFindings: 600,
  avgFindingsPerScan: 5.0,
};

const SAMPLE_SNAPSHOT = {
  id: "snap-1",
  ...SAMPLE_METRICS,
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// Helper: invoke function handler
// ---------------------------------------------------------------------------

async function runSnapshotMetrics(
  stepOverrides?: Partial<ReturnType<typeof createMockInngestStep>>,
) {
  const step = { ...createMockInngestStep(), ...stepOverrides };
  const event = {
    name: "scheduled/cron",
    data: {},
    ts: Date.now(),
    id: "test-event-snapshot-metrics",
  };
  return getInngestHandler(snapshotMetrics)({ event, step });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockComputeCurrentMetrics.mockResolvedValue(SAMPLE_METRICS);
  mockCreateMetricSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("snapshotMetrics — compute and store", () => {
  it("calls computeCurrentMetrics inside the step", async () => {
    await runSnapshotMetrics();

    expect(mockComputeCurrentMetrics).toHaveBeenCalledOnce();
  });

  it("calls createMetricSnapshot with the computed metrics", async () => {
    await runSnapshotMetrics();

    expect(mockCreateMetricSnapshot).toHaveBeenCalledWith(SAMPLE_METRICS);
  });

  it("returns the saved snapshot", async () => {
    const result = await runSnapshotMetrics();

    expect(result).toEqual(SAMPLE_SNAPSHOT);
  });
});

describe("snapshotMetrics — logging", () => {
  it("logs info with snapshot metadata after storing", async () => {
    await runSnapshotMetrics();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "snapshot-metrics-complete",
      expect.objectContaining({
        snapshotDate: SAMPLE_DATE.toISOString(),
        totalShops: 15,
        activeShops: 10,
        totalScans: 120,
        completionRate: 0.92,
      }),
    );
  });
});

describe("snapshotMetrics — cron heartbeat", () => {
  it("records a cron_heartbeat keyed to the function id after a successful run", async () => {
    await runSnapshotMetrics();

    expect(mockRecordCronHeartbeat).toHaveBeenCalledOnce();
    expect(mockRecordCronHeartbeat).toHaveBeenCalledWith("snapshot-metrics");
  });
});

describe("snapshotMetrics — uses a single step", () => {
  it("executes exactly one step.run call", async () => {
    const step = createMockInngestStep();

    await runSnapshotMetrics(step);

    expect(step.run).toHaveBeenCalledOnce();
  });

  it("names the step 'compute-and-store-metrics'", async () => {
    const step = createMockInngestStep();

    await runSnapshotMetrics(step);

    expect(step.run).toHaveBeenCalledWith("compute-and-store-metrics", expect.any(Function));
  });
});
