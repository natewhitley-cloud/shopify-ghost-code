/**
 * Acceptance tests for the Clean copy view model (gc-tib slice 5), written
 * before the module. The routes render only what this module returns, so the
 * merchant-facing rules live here.
 */
import { describe, expect, it } from "vitest";

import {
  CANDIDATE_BLOCK_REASONS,
  candidateBlockCopy,
  fixItemReasonCopy,
  groupCandidatesByApp,
  previewUrl,
  RUN_REFUSAL_REASONS,
  runRefusalCopy,
  runSummary,
  type CleanCopyCandidate,
} from "../../app/lib/clean-copy-view";

const cand = (over: Partial<CleanCopyCandidate>): CleanCopyCandidate => ({
  findingId: "f1",
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 10,
  appName: "Klaviyo",
  spanText: '<script src="https://static.klaviyo.com/a.js"></script>',
  blocked: null,
  ...over,
});

/** Merchant copy must never leak a machine code, an em dash, or "ghost code". */
function expectMerchantCopy(text: string) {
  expect(text.trim().length).toBeGreaterThan(0);
  expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  expect(text).not.toContain("—");
  expect(text.toLowerCase()).not.toContain("ghost code");
}

describe("groupCandidatesByApp", () => {
  it("groups by app, apps sorted by name, unknown app last, selectable and blocked split", () => {
    const groups = groupCandidatesByApp([
      cand({ findingId: "a", appName: "Loox" }),
      cand({ findingId: "b", appName: "Klaviyo" }),
      cand({ findingId: "c", appName: null, blocked: "APP_UNKNOWN" }),
      cand({ findingId: "d", appName: "Hotjar", blocked: "APP_HAS_LIVE_EMBED" }),
      cand({ findingId: "e", appName: "Klaviyo", lineNumber: 3 }),
    ]);
    expect(groups.map((g) => g.appName)).toEqual(["Hotjar", "Klaviyo", "Loox", null]);
    const klaviyo = groups[1];
    // Within a group: by filename, then line.
    expect(klaviyo.selectable.map((c) => c.findingId)).toEqual(["e", "b"]);
    expect(klaviyo.blocked).toEqual([]);
    expect(groups[0].blocked.map((c) => c.findingId)).toEqual(["d"]);
    expect(groups[3].selectable).toEqual([]);
  });

  it("returns an empty list for no candidates", () => {
    expect(groupCandidatesByApp([])).toEqual([]);
  });

  it("an app with a live embed is blocked as a whole (every candidate of that app)", () => {
    const groups = groupCandidatesByApp([
      cand({ findingId: "a", appName: "Judge.me", blocked: "APP_HAS_LIVE_EMBED" }),
      cand({ findingId: "b", appName: "Judge.me" }),
    ]);
    expect(groups[0].selectable).toEqual([]);
    expect(groups[0].blocked.map((c) => c.findingId).sort()).toEqual(["a", "b"]);
    expect(groups[0].blocked.every((c) => c.blocked === "APP_HAS_LIVE_EMBED")).toBe(true);
  });
});

describe("merchant copy for every reason", () => {
  it.each(CANDIDATE_BLOCK_REASONS)("candidate block %s", (reason) => {
    expectMerchantCopy(candidateBlockCopy(reason));
  });

  it.each(RUN_REFUSAL_REASONS)("run refusal %s", (reason) => {
    expectMerchantCopy(runRefusalCopy(reason));
  });

  it.each([
    "FILE_CHANGED",
    "CHECKSUM_UNVERIFIABLE",
    "SPAN_MISMATCH",
    "VALIDATION_FAILED:OVERLAPPING_SPANS",
    "VALIDATION_FAILED:IN_NON_CODE_REGION",
    "VALIDATION_FAILED:UNBALANCED_LIQUID",
    "VALIDATION_FAILED:SOMETHING_NEW",
    "UPSERT_FAILED",
    "JOB_TIMEOUT",
    "POST_WRITE_MISMATCH",
    "NOT_FIXABLE_TYPE",
    "INCOMPLETE",
    "TOTALLY_UNKNOWN_CODE",
    null,
  ])("fix item reason %s", (reason) => {
    expectMerchantCopy(fixItemReasonCopy(reason));
  });

  it("the run refusal list covers the service's reasons plus RUN_ACTIVE and DISPATCH_FAILED", () => {
    for (const r of [
      "FLAG_OFF",
      "EMPTY_SELECTION",
      "NOT_PROFESSIONAL",
      "SCOPE_MISSING",
      "SCAN_STALE",
      "MANIFEST_MISSING",
      "EMBED_STATUS_UNKNOWN",
      "TOO_MANY_FILES",
      "TOO_MANY_FINDINGS",
      "FINDINGS_REFUSED",
      "ACCESS_DENIED",
      "RUN_ACTIVE",
      "DISPATCH_FAILED",
    ]) {
      expect(RUN_REFUSAL_REASONS).toContain(r);
    }
  });

  it("unknown run refusal codes still get generic copy (never undefined)", () => {
    expectMerchantCopy(runRefusalCopy("SOMETHING_ELSE" as never));
  });
});

describe("runSummary", () => {
  const items = (statuses: string[]) => statuses.map((status) => ({ status }));

  it("active runs: info, no preview yet", () => {
    for (const status of ["pending", "duplicating", "writing"]) {
      const s = runSummary({
        status,
        doNotPublish: false,
        failureReason: null,
        items: items(["pending"]),
      });
      expect(s.tone).toBe("info");
      expect(s.active).toBe(true);
      expect(s.showPreview).toBe(false);
      expectMerchantCopy(s.heading);
    }
  });

  it("completed: success, preview shown, says how many were removed", () => {
    const s = runSummary({
      status: "completed",
      doNotPublish: false,
      failureReason: null,
      items: items(["removed", "removed", "removed"]),
    });
    expect(s.tone).toBe("success");
    expect(s.showPreview).toBe(true);
    expect(`${s.heading} ${s.body}`).toMatch(/\b3\b/);
    expectMerchantCopy(s.body);
  });

  it("partial: warning with X of Y, preview shown", () => {
    const s = runSummary({
      status: "partial",
      doNotPublish: false,
      failureReason: null,
      items: items(["removed", "skipped", "failed", "removed"]),
    });
    expect(s.tone).toBe("warning");
    expect(s.showPreview).toBe(true);
    expect(`${s.heading} ${s.body}`).toMatch(/\b2 of 4\b/);
  });

  it("failed: critical, no preview, body explains the failure reason", () => {
    const s = runSummary({
      status: "failed",
      doNotPublish: false,
      failureReason: "SCAN_STALE",
      items: items(["skipped"]),
    });
    expect(s.tone).toBe("critical");
    expect(s.showPreview).toBe(false);
    expect(s.body).toContain(runRefusalCopy("SCAN_STALE"));
  });

  it("doNotPublish overrides everything: critical, no preview, says not to publish", () => {
    for (const status of ["completed", "partial", "failed"]) {
      const s = runSummary({
        status,
        doNotPublish: true,
        failureReason: null,
        items: items(["removed"]),
      });
      expect(s.tone).toBe("critical");
      expect(s.showPreview).toBe(false);
      expect(`${s.heading} ${s.body}`.toLowerCase()).toMatch(/don.t publish|do not publish/);
    }
  });

  it("success copy tells the merchant they publish it themselves and the live theme is untouched", () => {
    const s = runSummary({
      status: "completed",
      doNotPublish: false,
      failureReason: null,
      items: items(["removed"]),
    });
    expect(s.body.toLowerCase()).toContain("publish");
    expect(s.body.toLowerCase()).toMatch(/live theme/);
  });
});

describe("previewUrl", () => {
  it("builds the storefront preview link from a theme GID", () => {
    expect(
      previewUrl("nw-dev-store-2.myshopify.com", "gid://shopify/OnlineStoreTheme/153006309553"),
    ).toBe("https://nw-dev-store-2.myshopify.com/?preview_theme_id=153006309553");
  });

  it("returns null without a copy theme or with a malformed id/domain", () => {
    expect(previewUrl("x.myshopify.com", null)).toBeNull();
    expect(previewUrl("x.myshopify.com", "gid://shopify/OnlineStoreTheme/abc")).toBeNull();
    expect(previewUrl("evil.com/@x.myshopify.com", "gid://shopify/OnlineStoreTheme/1")).toBeNull();
  });
});
