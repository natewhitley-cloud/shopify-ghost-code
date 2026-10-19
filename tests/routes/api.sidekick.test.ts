/**
 * Tests for the Sidekick resource routes (gc-5nok):
 * app/routes/api.sidekick.latest-scan.ts and api.sidekick.speed.ts.
 * Auth, CORS wrapping, the `results` envelope and error reporting. The
 * summary logic and plan gating are covered in
 * tests/services/sidekick-scan-summary.server.test.ts and
 * tests/services/sidekick-speed-summary.server.test.ts.
 */
import type { LoaderFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../app/models/ops-event.server", () => ({
  recordApiError: vi.fn(async () => undefined),
}));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../app/services/sidekick-scan-summary.server", () => ({
  getSidekickScanSummary: vi.fn(),
}));
vi.mock("../../app/services/sidekick-speed-summary.server", () => ({
  getSidekickSpeedSummary: vi.fn(),
}));

import { logger } from "../../app/lib/logger.server";
import { recordApiError } from "../../app/models/ops-event.server";
import { loader as latestScanLoader } from "../../app/routes/api.sidekick.latest-scan";
import { loader as speedLoader } from "../../app/routes/api.sidekick.speed";
import { getSidekickScanSummary } from "../../app/services/sidekick-scan-summary.server";
import { getSidekickSpeedSummary } from "../../app/services/sidekick-speed-summary.server";
import { authenticate } from "../../app/shopify.server";

const mockAdmin = vi.mocked(authenticate.admin);
const admin = { graphql: vi.fn() };
const cors = vi.fn((res: Response) => {
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
});

const routes = [
  {
    name: "latest-scan",
    loader: latestScanLoader,
    service: vi.mocked(getSidekickScanSummary) as ReturnType<typeof vi.fn>,
    code: "sidekick_latest_scan_failed",
    expectedArgs: [admin, "a.myshopify.com"],
  },
  {
    name: "speed",
    loader: speedLoader,
    service: vi.mocked(getSidekickSpeedSummary) as ReturnType<typeof vi.fn>,
    code: "sidekick_speed_failed",
    expectedArgs: ["a.myshopify.com"],
  },
];

function call(loader: typeof latestScanLoader, name: string, query = "") {
  return loader({
    request: new Request(`https://app.example.com/api/sidekick/${name}${query}`),
    params: {},
    context: {},
  } as LoaderFunctionArgs) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdmin.mockResolvedValue({
    admin,
    session: { shop: "a.myshopify.com" },
    cors,
  } as never);
});

describe.each(routes)(
  "GET /api/sidekick/$name",
  ({ name, loader, service, code, expectedArgs }) => {
    it("rejects an unauthenticated request and never reads data", async () => {
      mockAdmin.mockRejectedValue(new Response(null, { status: 401 }));
      await expect(call(loader, name)).rejects.toMatchObject({ status: 401 });
      expect(service).not.toHaveBeenCalled();
    });

    it("uses the session shop (never a query param), wraps the summary in results, and applies cors", async () => {
      const summary = { status: "ok" };
      service.mockResolvedValue(summary);
      const res = await call(loader, name, "?shop=evil.myshopify.com");
      expect(service).toHaveBeenCalledWith(...expectedArgs);
      expect(cors).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await res.json()).toEqual({ results: [summary] });
    });

    it("returns 200 through cors for a no_data result", async () => {
      service.mockResolvedValue({ status: "no_data", message: "m" });
      const res = await call(loader, name);
      expect(res.status).toBe(200);
      expect(cors).toHaveBeenCalledTimes(1);
    });

    it("answers a service failure with a CORS-wrapped 500 error envelope and reports code + shop only", async () => {
      service.mockRejectedValue(new Error("Prisma timeout token=shpat_SECRET"));
      const res = await call(loader, name);
      expect(res.status).toBe(500);
      expect(cors).toHaveBeenCalledTimes(1);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const body = await res.json();
      expect(body).toEqual({
        results: [{ status: "error", message: "GhostCode could not read this data right now." }],
      });
      expect(JSON.stringify(body)).not.toContain("shpat_SECRET");
      expect(recordApiError).toHaveBeenCalledTimes(1);
      expect(recordApiError).toHaveBeenCalledWith({
        level: "error",
        code,
        shopDomain: "a.myshopify.com",
        message: "Sidekick data read failed",
      });
      expect(logger.error).toHaveBeenCalledWith(code, {
        shop: "a.myshopify.com",
        errorName: "Error",
      });
      // Never the error message (it can embed query data or tokens).
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("shpat_SECRET");
    });

    it("still answers the error envelope when recording the error fails", async () => {
      service.mockRejectedValue(new Error("boom"));
      vi.mocked(recordApiError).mockRejectedValueOnce(new Error("db down"));
      const res = await call(loader, name);
      expect(res.status).toBe(500);
      expect(cors).toHaveBeenCalledTimes(1);
    });

    it("lets an authenticate-thrown Response pass through without reporting", async () => {
      const thrown = new Response(null, { status: 302 });
      mockAdmin.mockRejectedValue(thrown);
      await expect(call(loader, name)).rejects.toBe(thrown);
      expect(recordApiError).not.toHaveBeenCalled();
      expect(cors).not.toHaveBeenCalled();
    });
  },
);
