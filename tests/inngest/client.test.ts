import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Boot-guard tests for the Inngest client (OPS-3 / SEC-3).
 *
 * The guard lives at module load in inngest/client.ts, so each case must
 * reset the module registry and re-import under a freshly stubbed env. We
 * stub NODE_ENV and the two Inngest keys, then dynamic-import the module to
 * observe whether construction throws.
 */
describe("inngest client boot guard", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function importClient() {
    return import("../../inngest/client");
  }

  describe("in production", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it("throws when INNGEST_EVENT_KEY is missing", async () => {
      vi.stubEnv("INNGEST_EVENT_KEY", "");
      vi.stubEnv("INNGEST_SIGNING_KEY", "signkey_present");

      await expect(importClient()).rejects.toThrow(
        "INNGEST_EVENT_KEY environment variable must be set in production",
      );
    });

    it("throws when INNGEST_SIGNING_KEY is missing", async () => {
      vi.stubEnv("INNGEST_EVENT_KEY", "eventkey_present");
      vi.stubEnv("INNGEST_SIGNING_KEY", "");

      await expect(importClient()).rejects.toThrow(
        "INNGEST_SIGNING_KEY environment variable must be set in production",
      );
    });

    it("does not throw when both keys are present", async () => {
      vi.stubEnv("INNGEST_EVENT_KEY", "eventkey_present");
      vi.stubEnv("INNGEST_SIGNING_KEY", "signkey_present");

      await expect(importClient()).resolves.toHaveProperty("inngest");
    });
  });

  describe("in development", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development");
    });

    it("does not throw when both Inngest keys are missing", async () => {
      vi.stubEnv("INNGEST_EVENT_KEY", "");
      vi.stubEnv("INNGEST_SIGNING_KEY", "");

      const mod = await importClient();
      expect(mod.inngest).toBeDefined();
    });
  });
});
