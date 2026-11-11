/**
 * Extra cases for the Clean copy view model (gc-tib slice 5), beside the
 * acceptance tests in clean-copy-view.test.ts: worker failure reasons, prototype
 * keys as codes, run summary edges, and the preview link's host rules.
 */
import { describe, expect, it } from "vitest";

import {
  candidateBlockCopy,
  findingRefusalCopy,
  fixItemReasonCopy,
  groupCandidatesByApp,
  previewUrl,
  runRefusalCopy,
  runSummary,
  type CleanCopyCandidate,
} from "../../app/lib/clean-copy-view";
import type { SpliceRefusal } from "../../app/lib/theme-splice";

function expectMerchantCopy(text: string) {
  expect(text.trim().length).toBeGreaterThan(0);
  expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  expect(text).not.toContain("—");
  expect(text.toLowerCase()).not.toContain("ghost code");
}

const cand = (over: Partial<CleanCopyCandidate>): CleanCopyCandidate => ({
  findingId: "f",
  findingType: "GHOST_SCRIPT",
  filename: "layout/theme.liquid",
  lineNumber: 1,
  appName: "Klaviyo",
  spanText: "<script></script>",
  blocked: null,
  ...over,
});

describe("run failure reasons the worker writes", () => {
  it.each([
    "DUPLICATE_FAILED",
    "DUPLICATE_PROCESSING_FAILED",
    "DUPLICATE_TIMEOUT",
    "COPY_IS_SOURCE",
    "COPY_MISSING",
    "COPY_NOT_UNPUBLISHED",
    "NO_COPY",
    "WRITE_REFUSED",
    "STALE",
    "FLAG_OFF",
    "ACCESS_DENIED",
  ])("%s has its own plain copy", (reason) => {
    const copy = runRefusalCopy(reason);
    expectMerchantCopy(copy);
    expect(copy).not.toBe(runRefusalCopy("SOMETHING_UNKNOWN"));
  });

  it("null, empty and prototype keys get generic copy, never undefined", () => {
    const generic = runRefusalCopy("SOMETHING_UNKNOWN");
    for (const code of [
      null,
      undefined,
      "",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(runRefusalCopy(code)).toBe(generic);
    }
  });
});

describe("fixItemReasonCopy", () => {
  it("a removed item (null) reads as removed", () => {
    expect(fixItemReasonCopy(null)).toBe("Removed.");
  });

  // Exactly the codes the service writes after "VALIDATION_FAILED:" (gc-wkpc
  // L6): every splice refusal, plus CHECK_FAILED. The Record makes tsc fail
  // when SpliceRefusal gains a member this list lacks.
  const WRITTEN_VALIDATION_CODES: Record<SpliceRefusal | "CHECK_FAILED", true> = {
    OUT_OF_BOUNDS: true,
    OVERLAPPING_SPANS: true,
    IN_NON_CODE_REGION: true,
    UNBALANCED_LIQUID: true,
    JOINS_TEXT: true,
    STRUCTURE_CHANGED: true,
    CHECK_FAILED: true,
  };

  it("every code written under VALIDATION_FAILED gets its own skipped copy, not the generic", () => {
    const generic = fixItemReasonCopy("VALIDATION_FAILED:SOMETHING_NEW");
    for (const reason of Object.keys(WRITTEN_VALIDATION_CODES)) {
      const copy = fixItemReasonCopy(`VALIDATION_FAILED:${reason}`);
      expectMerchantCopy(copy);
      expect(copy.startsWith("Skipped.")).toBe(true);
      expect(copy).not.toBe(generic);
    }
  });

  it("different known causes get different copy", () => {
    const codes = [
      "FILE_CHANGED",
      "CHECKSUM_UNVERIFIABLE",
      "SPAN_MISMATCH",
      "UPSERT_FAILED",
      "JOB_TIMEOUT",
      "POST_WRITE_MISMATCH",
      "NOT_FIXABLE_TYPE",
      "INCOMPLETE",
      "VALIDATION_FAILED:OVERLAPPING_SPANS",
    ];
    expect(new Set(codes.map(fixItemReasonCopy)).size).toBe(codes.length);
  });

  it("run-level reasons copied onto items reuse the run copy, behind 'Not removed.'", () => {
    const copy = fixItemReasonCopy("SCAN_STALE");
    expect(copy).toBe(`Not removed. ${runRefusalCopy("SCAN_STALE")}`);
    expectMerchantCopy(copy);
  });

  it("unknown, empty and prototype-key codes get the generic not-removed line", () => {
    const generic = fixItemReasonCopy("TOTALLY_UNKNOWN_CODE");
    expect(generic.startsWith("Not removed.")).toBe(true);
    for (const code of ["", "constructor", "__proto__", "VALIDATION_FAILED:constructor"]) {
      expectMerchantCopy(fixItemReasonCopy(code));
    }
    expect(fixItemReasonCopy("constructor")).toBe(generic);
  });
});

describe("findingRefusalCopy", () => {
  it.each([
    "NOT_IN_SCAN",
    "NOT_FIXABLE_TYPE",
    "NO_SPAN",
    "PATH_NOT_ALLOWED",
    "IGNORED",
    "APP_UNKNOWN",
    "APP_HAS_LIVE_EMBED",
    "APP_NOT_CONFIRMED",
    "MANIFEST_MD5_MISSING",
    "SOMETHING_NEW",
    "constructor",
  ])("%s", (reason) => {
    expectMerchantCopy(findingRefusalCopy(reason));
  });

  it("reuses the candidate copy for block reasons", () => {
    expect(findingRefusalCopy("IGNORED")).toBe(candidateBlockCopy("IGNORED"));
  });
});

describe("runSummary edges", () => {
  const input = (over: Record<string, unknown>) => ({
    status: "completed",
    doNotPublish: false,
    failureReason: null,
    items: [{ status: "removed" }],
    ...over,
  });

  it("says '1 piece' for a single removal", () => {
    const s = runSummary(input({}));
    expect(s.body).toContain("1 piece of leftover code");
    expect(s.body).not.toContain("1 pieces");
  });

  it("a partial run with nothing removed offers no preview and does not tell them to publish", () => {
    const s = runSummary(
      input({ status: "partial", items: [{ status: "skipped" }, { status: "failed" }] }),
    );
    expect(s.tone).toBe("warning");
    expect(s.showPreview).toBe(false);
    expect(s.body).toContain("0 of 2");
    expect(s.body).not.toContain("publish it");
  });

  it("a failed run with an unknown or missing reason still explains itself", () => {
    for (const failureReason of [null, "MYSTERY"]) {
      const s = runSummary(input({ status: "failed", failureReason }));
      expect(s.tone).toBe("critical");
      expectMerchantCopy(s.body);
      expect(s.body.toLowerCase()).toContain("live theme was not changed");
    }
  });

  it("an unknown status never shows a preview and does not poll forever", () => {
    for (const status of ["", "weird", "constructor"]) {
      const s = runSummary(input({ status }));
      expect(s.showPreview).toBe(false);
      expect(s.active).toBe(false);
      expectMerchantCopy(s.heading);
      expectMerchantCopy(s.body);
    }
  });

  it("do-not-publish on an active run stays critical and keeps polling", () => {
    const s = runSummary(input({ status: "writing", doNotPublish: true }));
    expect(s.tone).toBe("critical");
    expect(s.active).toBe(true);
    expect(s.showPreview).toBe(false);
  });

  it("every summary heading and body is plain merchant copy", () => {
    for (const status of ["pending", "duplicating", "writing", "completed", "partial", "failed"]) {
      for (const doNotPublish of [false, true]) {
        const s = runSummary(input({ status, doNotPublish, failureReason: "DUPLICATE_TIMEOUT" }));
        expectMerchantCopy(s.heading);
        expectMerchantCopy(s.body);
      }
    }
  });
});

describe("groupCandidatesByApp edges", () => {
  it("does not change its input", () => {
    const input = [
      cand({ findingId: "a", appName: "B", blocked: "APP_HAS_LIVE_EMBED", spanText: null }),
      cand({ findingId: "b", appName: "B" }),
    ];
    const copy = JSON.parse(JSON.stringify(input));
    groupCandidatesByApp(input);
    expect(input).toEqual(copy);
  });

  it("a whole-app embed block removes the code text from the other candidates", () => {
    const groups = groupCandidatesByApp([
      cand({ findingId: "a", appName: "Judge.me", blocked: "APP_HAS_LIVE_EMBED", spanText: null }),
      cand({ findingId: "b", appName: "Judge.me" }),
    ]);
    expect(groups[0].blocked.every((c) => c.spanText === null)).toBe(true);
  });

  it("keeps other apps selectable when one app has a live embed", () => {
    const groups = groupCandidatesByApp([
      cand({ findingId: "a", appName: "Judge.me", blocked: "APP_HAS_LIVE_EMBED", spanText: null }),
      cand({ findingId: "b", appName: "Loox" }),
    ]);
    expect(groups.find((g) => g.appName === "Loox")?.selectable).toHaveLength(1);
  });

  it("sorts by filename, then by line number numerically", () => {
    const groups = groupCandidatesByApp([
      cand({ findingId: "a", filename: "snippets/b.liquid", lineNumber: 2 }),
      cand({ findingId: "b", filename: "layout/theme.liquid", lineNumber: 10 }),
      cand({ findingId: "c", filename: "layout/theme.liquid", lineNumber: 9 }),
    ]);
    expect(groups[0].selectable.map((c) => c.findingId)).toEqual(["c", "b", "a"]);
  });
});

describe("previewUrl host rules", () => {
  const GID = "gid://shopify/OnlineStoreTheme/42";

  it("accepts a plain shop domain, any case", () => {
    expect(previewUrl("My-Shop.myshopify.com", GID)).toBe(
      "https://My-Shop.myshopify.com/?preview_theme_id=42",
    );
  });

  it("rejects anything that is not a plain *.myshopify.com host", () => {
    for (const domain of [
      "",
      "myshopify.com",
      "shop.example.com",
      "shop.myshopify.com.evil.com",
      "evil.com/shop.myshopify.com",
      "user@shop.myshopify.com",
      "shop.myshopify.com:8080",
      "a.b.myshopify.com",
      "shop.myshopify.com/",
      " shop.myshopify.com",
      "https://shop.myshopify.com",
    ]) {
      expect(previewUrl(domain, GID)).toBeNull();
    }
  });

  it("rejects malformed theme ids", () => {
    for (const gid of [
      undefined,
      "",
      "gid://shopify/Theme/42x",
      "gid://shopify/Product/42",
      "42/../1",
    ]) {
      expect(previewUrl("shop.myshopify.com", gid as never)).toBeNull();
    }
  });
});
