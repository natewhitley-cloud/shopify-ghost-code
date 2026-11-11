/**
 * gc-tib.22: the adapter's live read of the Professional subscription and its
 * trial end (Admin API AppSubscription createdAt + trialDays).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { FakeShopify, MAIN_ID, THEME_FILES } from "./clean-copy.fakes";
import {
  createCleanCopyAdmin,
  subscriptionTrialEnd,
} from "../../app/services/clean-copy-admin.server";

let shop: FakeShopify;
let admin: ReturnType<typeof createCleanCopyAdmin>;

beforeEach(() => {
  shop = new FakeShopify(MAIN_ID, THEME_FILES);
  admin = createCleanCopyAdmin(shop);
});

const pro = (over: Record<string, unknown> = {}) => ({
  name: "Professional",
  status: "ACTIVE",
  createdAt: "2026-11-10T15:30:00Z",
  trialDays: 7,
  ...over,
});

describe("subscriptionTrialEnd", () => {
  it("adds trialDays and rounds up to the next 00:00 UTC", () => {
    expect(subscriptionTrialEnd("2026-11-10T15:30:00Z", 7)?.toISOString()).toBe(
      "2026-11-18T00:00:00.000Z",
    );
  });

  it("keeps an end that is already 00:00 UTC", () => {
    expect(subscriptionTrialEnd("2026-11-10T00:00:00Z", 7)?.toISOString()).toBe(
      "2026-11-17T00:00:00.000Z",
    );
  });

  it("returns null for no trial days", () => {
    expect(subscriptionTrialEnd("2026-11-10T15:30:00Z", 0)).toBeNull();
  });

  it.each([
    ["missing createdAt", undefined, 7],
    ["unparseable createdAt", "not a date", 7],
    ["numeric createdAt", 12345, 7],
    ["missing trialDays", "2026-11-10T00:00:00Z", undefined],
    ["negative trialDays", "2026-11-10T00:00:00Z", -1],
    ["fractional trialDays", "2026-11-10T00:00:00Z", 1.5],
    ["string trialDays", "2026-11-10T00:00:00Z", "7"],
  ])("returns undefined (malformed) for %s", (_label, createdAt, trialDays) => {
    expect(subscriptionTrialEnd(createdAt, trialDays)).toBeUndefined();
  });
});

describe("getProfessionalSubscription", () => {
  it("reads the trial end of an ACTIVE Professional subscription", async () => {
    shop.subscriptions = [pro()];
    const res = await admin.getProfessionalSubscription();
    expect(res).toEqual({
      ok: true,
      value: { trialEndsAt: new Date("2026-11-18T00:00:00Z") },
    });
    expect(shop.count("CleanCopySubscriptions")).toBe(1);
  });

  it("returns null when there is no active Professional subscription", async () => {
    shop.subscriptions = [pro({ name: "Standard" })];
    expect(await admin.getProfessionalSubscription()).toEqual({ ok: true, value: null });
    shop.subscriptions = [];
    expect(await admin.getProfessionalSubscription()).toEqual({ ok: true, value: null });
  });

  it.each(["PENDING", "CANCELLED", "FROZEN", "EXPIRED", "DECLINED"])(
    "ignores a Professional subscription in status %s",
    async (status) => {
      shop.subscriptions = [pro({ status })];
      expect(await admin.getProfessionalSubscription()).toEqual({ ok: true, value: null });
    },
  );

  it("ignores a name that only resembles Professional", async () => {
    shop.subscriptions = [pro({ name: "professional" }), pro({ name: "Professional " })];
    expect(await admin.getProfessionalSubscription()).toEqual({ ok: true, value: null });
  });

  it("no trial days means no trial", async () => {
    shop.subscriptions = [pro({ trialDays: 0 })];
    expect(await admin.getProfessionalSubscription()).toEqual({
      ok: true,
      value: { trialEndsAt: null },
    });
  });

  it("several Professional subscriptions: the latest trial end wins", async () => {
    shop.subscriptions = [
      pro({ trialDays: 0 }),
      pro({ createdAt: "2026-11-12T01:00:00Z", trialDays: 3 }),
      pro({ createdAt: "2026-11-01T01:00:00Z", trialDays: 7 }),
    ];
    expect(await admin.getProfessionalSubscription()).toEqual({
      ok: true,
      value: { trialEndsAt: new Date("2026-11-16T00:00:00Z") },
    });
  });

  it("a malformed Professional subscription is TRANSIENT, not a guess", async () => {
    shop.subscriptions = [pro({ trialDays: null })];
    expect(await admin.getProfessionalSubscription()).toMatchObject({
      ok: false,
      error: "TRANSIENT",
    });
  });

  it("a malformed non-Professional subscription does not matter", async () => {
    shop.subscriptions = [pro({ name: "Standard", trialDays: null }), pro({ trialDays: 0 })];
    expect(await admin.getProfessionalSubscription()).toEqual({
      ok: true,
      value: { trialEndsAt: null },
    });
  });

  it("non-object list entries are ignored", async () => {
    shop.subscriptions = [null as never, "x" as never, pro({ trialDays: 0 })];
    expect(await admin.getProfessionalSubscription()).toEqual({
      ok: true,
      value: { trialEndsAt: null },
    });
  });

  it("a missing list is TRANSIENT", async () => {
    shop.overrides.CleanCopySubscriptions = () => ({ data: { currentAppInstallation: null } });
    expect(await admin.getProfessionalSubscription()).toMatchObject({
      ok: false,
      error: "TRANSIENT",
    });
  });

  it("GraphQL errors and thrown requests are typed failures", async () => {
    shop.overrides.CleanCopySubscriptions = () => ({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    });
    expect(await admin.getProfessionalSubscription()).toMatchObject({
      ok: false,
      error: "TRANSIENT",
    });
    shop.overrides.CleanCopySubscriptions = () => new Error("socket hang up");
    expect(await admin.getProfessionalSubscription()).toMatchObject({
      ok: false,
      error: "TRANSIENT",
    });
  });
});
