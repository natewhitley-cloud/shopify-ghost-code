/**
 * Cron schedule table + heartbeat expectations (gc-ngx6).
 *
 * Every cron string lives in an exported const next to its function. This pins
 * the decided slot plan (off :00, staggered around ClearSignal's :02/:07 hourly
 * crons on the shared Inngest account) and keeps CRON_HEARTBEAT_EXPECTATIONS in
 * step with the registered cron functions.
 */

import { describe, it, expect, vi } from "vitest";

const registered = vi.hoisted(() => [] as Array<{ id: string; cron?: string }>);

vi.mock("../../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn((config: { id: string }, trigger: { cron?: string }) => {
      registered.push({ id: config.id, cron: trigger.cron });
      return { fn: vi.fn() };
    }),
  },
}));
vi.mock("../../app/models/ops-event.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/models/ops-event.server")>();
  return { ...actual, recordCronHeartbeat: vi.fn() };
});
vi.mock("../../app/db.server", () => ({ default: {} }));

import { CRON_HEARTBEAT_EXPECTATIONS } from "../../app/models/ops-event.server";
import { MONITOR_DEEP_HEALTH_CRON } from "../../inngest/functions/monitor-deep-health";
import { MONITOR_SCAN_FAILURES_CRON } from "../../inngest/functions/monitor-scan-failures";
import { OPERATOR_DIGEST_CRON } from "../../inngest/functions/operator-digest";
import { POLL_THEME_CHANGES_CRON } from "../../inngest/functions/poll-theme-changes";
import { RECONCILE_INSTALLS_CRON } from "../../inngest/functions/reconcile-installs";
import { SNAPSHOT_METRICS_CRON } from "../../inngest/functions/snapshot-metrics";
import { WEEKLY_SCAN_CRON } from "../../inngest/functions/weekly-scan";

const EXPECTED: Array<[string, string, string]> = [
  ["monitor-deep-health", MONITOR_DEEP_HEALTH_CRON, "37 * * * *"],
  ["monitor-scan-failures", MONITOR_SCAN_FAILURES_CRON, "15 */6 * * *"],
  ["snapshot-metrics", SNAPSHOT_METRICS_CRON, "20 6 * * *"],
  ["weekly-scan", WEEKLY_SCAN_CRON, "40 6 * * 0"],
  ["poll-theme-changes", POLL_THEME_CHANGES_CRON, "0 6 * * *"],
  ["reconcile-installs", RECONCILE_INSTALLS_CRON, "TZ=America/Denver 0 6 * * *"],
  ["operator-digest", OPERATOR_DIGEST_CRON, "TZ=America/Denver 0 7 * * *"],
];

describe("cron schedules", () => {
  it.each(EXPECTED)("%s uses the decided schedule const", (id, constValue, decided) => {
    expect(constValue).toBe(decided);
    expect(registered.find((f) => f.id === id)?.cron).toBe(decided);
  });

  it("has no */10 or */15 crons left (watch-stale-scans removed)", () => {
    const crons = registered.filter((f) => f.cron).map((f) => f.cron);
    expect(crons.some((c) => c!.startsWith("*/"))).toBe(false);
    expect(registered.some((f) => f.id === "watch-stale-scans")).toBe(false);
  });
});

describe("CRON_HEARTBEAT_EXPECTATIONS", () => {
  it("drops watch-stale-scans and makes monitor-deep-health hourly", () => {
    const byKey = new Map(CRON_HEARTBEAT_EXPECTATIONS.map((e) => [e.key, e.intervalMs]));
    expect(byKey.has("watch-stale-scans")).toBe(false);
    expect(byKey.get("monitor-deep-health")).toBe(60 * 60 * 1000);
  });

  it("covers exactly the registered cron functions", () => {
    const cronIds = registered.filter((f) => f.cron).map((f) => f.id);
    expect(CRON_HEARTBEAT_EXPECTATIONS.map((e) => e.key).sort()).toEqual([...cronIds].sort());
  });
});
