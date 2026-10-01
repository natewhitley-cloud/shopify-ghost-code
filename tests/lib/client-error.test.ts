/**
 * Tests for app/lib/client-error.ts (gc-nn6): the pure sanitize / dedupe /
 * rate-limit core shared by the browser reporter and the server action. The
 * server re-runs the SAME sanitizer on whatever the client sent, so these
 * cases are the privacy contract for every stored client_error row.
 */
import { describe, it, expect } from "vitest";

import {
  browserFamily,
  CLIENT_ERROR_LIMITS,
  createReportGate,
  isClientErrorKind,
  isReportableStatus,
  sanitizeClientErrorReport,
  sanitizeMessage,
  sanitizePath,
  sanitizeStack,
  sanitizeStatus,
  scrubText,
} from "../../app/lib/client-error";

const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZGVzdCI6InNob3AifQ.dGhpc2lzYXNpZ25hdHVyZQ";

describe("scrubText", () => {
  it("strips query strings and hashes from URLs but keeps the path", () => {
    expect(scrubText("Failed https://x.example/a/b?token=abc&shop=s#frag here")).toBe(
      "Failed https://x.example/a/b here",
    );
  });

  it("keeps a stack frame's :line:col after stripping the query", () => {
    expect(scrubText("at f (https://app.example/assets/x.js?v=12:10:5)")).toBe(
      "at f (https://app.example/assets/x.js:10:5)",
    );
  });

  it("redacts JWTs (session tokens), bearer tokens and email addresses", () => {
    const out = scrubText(`id_token ${JWT} Bearer abc.def-123 mail me@shop.com now`);
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("abc.def-123");
    expect(out).not.toContain("me@shop.com");
    expect(out).toContain("[redacted]");
    expect(out).toContain("[email]");
  });

  it("strips a query string from a bare path at the start or after a space", () => {
    expect(scrubText("/app/x.data?shop=s.myshopify.com failed")).toBe("/app/x.data failed");
    expect(scrubText("GET /app/x.data?shop=s -> 500")).toBe("GET /app/x.data -> 500");
  });

  it("leaves plain text alone", () => {
    expect(scrubText("Cannot read properties of undefined (reading 'x')")).toBe(
      "Cannot read properties of undefined (reading 'x')",
    );
  });
});

describe("scrubText — audit M1 hardening", () => {
  // Pre-fix: the EMAIL regex took ~8s on 100 KB with no '@' (quadratic).
  it("is fast on a long unbroken word with no '@'", () => {
    const start = performance.now();
    scrubText("a".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("is fast on a long scheme-like run", () => {
    const start = performance.now();
    scrubText("a".repeat(100_000) + "://x?y=1");
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("redacts Shopify access tokens", () => {
    // Built at runtime so the literal never looks like a real token to secret scanners.
    const token = ["shpat", "_", "ab".repeat(16)].join("");
    const out = scrubText(`token ${token} leaked`);
    expect(out).not.toContain(token);
    expect(out).toContain("[redacted]");
  });

  it("still redacts an email inside long text", () => {
    expect(scrubText(`${"x ".repeat(100)}owner@shop.com`)).toContain("[email]");
  });
});

describe("sanitizeMessage", () => {
  it("caps at 300 characters", () => {
    const out = sanitizeMessage("a".repeat(1000));
    expect(out.length).toBe(CLIENT_ERROR_LIMITS.messageChars);
    expect(CLIENT_ERROR_LIMITS.messageChars).toBe(300);
  });

  it("scrubs before truncating so a query string cannot survive at the boundary", () => {
    const out = sanitizeMessage(`${"m".repeat(250)} https://x.example/p?secret=${"s".repeat(100)}`);
    expect(out).not.toContain("secret");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeMessage("  a\n\n  b\tc  ")).toBe("a b c");
  });

  it.each([undefined, null, 42, {}, []])("returns '' for a non-string %j", (raw) => {
    expect(sanitizeMessage(raw)).toBe("");
  });
});

describe("sanitizeStack", () => {
  const v8 = [
    "TypeError: boom",
    ...Array.from(
      { length: 9 },
      (_, i) => `    at fn${i} (https://app.example/assets/a.js?v=1:${i}:1)`,
    ),
  ].join("\n");

  it("keeps only the top 5 frames and drops the leading message line", () => {
    const out = sanitizeStack(v8)!;
    const frames = out.split("\n");
    expect(frames).toHaveLength(5);
    expect(frames[0]).toBe("at fn0 (https://app.example/assets/a.js:0:1)");
    expect(out).not.toContain("TypeError");
    expect(out).not.toContain("?v=1");
  });

  it("accepts Firefox/Safari fn@url frames", () => {
    const out = sanitizeStack("fn@https://app.example/a.js:1:2\n@https://app.example/b.js:3:4")!;
    expect(out.split("\n")).toEqual([
      "fn@https://app.example/a.js:1:2",
      "@https://app.example/b.js:3:4",
    ]);
  });

  it("truncates each frame", () => {
    const out = sanitizeStack(`    at ${"x".repeat(1000)} (a.js:1:1)`)!;
    expect(out.length).toBe(CLIENT_ERROR_LIMITS.frameChars);
  });

  it.each([undefined, null, 5, "", "no frames here"])("returns undefined for %j", (raw) => {
    expect(sanitizeStack(raw)).toBeUndefined();
  });
});

describe("sanitizePath", () => {
  it.each([
    ["/app/scans/abc?shop=x.myshopify.com&host=abc", "/app/scans/abc"],
    ["/app#section", "/app"],
    ["/app/settings", "/app/settings"],
    ["https://app.example/app/scans?id_token=zzz", "/app/scans"],
  ])("%s -> %s", (raw, expected) => {
    expect(sanitizePath(raw)).toBe(expected);
  });

  it.each([undefined, null, 3, "", "relative/path", "javascript:alert(1)"])(
    "returns '' for %j",
    (raw) => {
      expect(sanitizePath(raw)).toBe("");
    },
  );

  it("caps the path length", () => {
    expect(sanitizePath(`/${"p".repeat(500)}`).length).toBe(CLIENT_ERROR_LIMITS.pathChars);
  });
});

describe("sanitizeStatus", () => {
  it.each([
    [0, 0],
    [500, 500],
    ["502", 502],
    [404, 404],
  ])("%j -> %j", (raw, expected) => {
    expect(sanitizeStatus(raw)).toBe(expected);
  });

  it.each([undefined, null, "", "abc", -1, 600, 1.5, "1e3"])("returns undefined for %j", (raw) => {
    expect(sanitizeStatus(raw)).toBeUndefined();
  });
});

describe("isClientErrorKind / isReportableStatus", () => {
  it("accepts only the four kinds", () => {
    for (const k of ["error", "rejection", "boundary", "fetch"]) {
      expect(isClientErrorKind(k)).toBe(true);
    }
    for (const k of ["ERROR", "other", "", null, undefined, 1]) {
      expect(isClientErrorKind(k)).toBe(false);
    }
  });

  it("reports network failures and 4xx/5xx except 401 (App Bridge re-auth)", () => {
    expect(isReportableStatus(0)).toBe(true);
    expect(isReportableStatus(400)).toBe(true);
    expect(isReportableStatus(404)).toBe(true);
    expect(isReportableStatus(500)).toBe(true);
    expect(isReportableStatus(503)).toBe(true);
    expect(isReportableStatus(401)).toBe(false);
    expect(isReportableStatus(200)).toBe(false);
    expect(isReportableStatus(204)).toBe(false);
    expect(isReportableStatus(302)).toBe(false);
  });
});

describe("sanitizeClientErrorReport", () => {
  it("returns a fully sanitized report", () => {
    const report = sanitizeClientErrorReport({
      kind: "fetch",
      message: `GET /app/scans.data?x=${JWT} -> 502`,
      stack: "    at a (https://h/a.js?q=1:1:1)",
      path: "/app/scans?shop=s.myshopify.com",
      status: "502",
    });
    expect(report).toEqual({
      kind: "fetch",
      message: "GET /app/scans.data -> 502",
      stack: "at a (https://h/a.js:1:1)",
      path: "/app/scans",
      status: 502,
    });
  });

  it("omits stack and status when absent or invalid", () => {
    expect(sanitizeClientErrorReport({ kind: "error", message: "x", path: "/app" })).toEqual({
      kind: "error",
      message: "x",
      path: "/app",
    });
  });

  it("drops unknown fields (e.g. a client-supplied shop)", () => {
    const report = sanitizeClientErrorReport({
      kind: "error",
      message: "x",
      path: "/app",
      shop: "other.myshopify.com",
      userAgent: "Mozilla",
    });
    expect(report).not.toHaveProperty("shop");
    expect(report).not.toHaveProperty("userAgent");
  });

  it.each([{}, { kind: "nope", message: "x" }, { kind: "error", message: "" }])(
    "returns null for an invalid report %j",
    (raw) => {
      expect(sanitizeClientErrorReport(raw)).toBeNull();
    },
  );
});

describe("createReportGate", () => {
  const r = (message: string, extra: Record<string, unknown> = {}) => ({
    kind: "error" as const,
    message,
    path: "/app",
    ...extra,
  });

  it("dedupes identical reports within a page load", () => {
    const gate = createReportGate();
    expect(gate.admit(r("a"))).toBe(true);
    expect(gate.admit(r("a"))).toBe(false);
    expect(gate.admit(r("a", { path: "/app/scans" }))).toBe(true);
    expect(gate.admit(r("a", { kind: "rejection" }))).toBe(true);
    expect(gate.admit(r("a", { status: 500 }))).toBe(true);
  });

  it("does not dedupe on stack differences alone (same error, different call site)", () => {
    const gate = createReportGate();
    expect(gate.admit(r("a", { stack: "at x" }))).toBe(true);
    expect(gate.admit(r("a", { stack: "at y" }))).toBe(false);
  });

  it("admits at most 5 distinct reports per page load", () => {
    expect(CLIENT_ERROR_LIMITS.beaconsPerPage).toBe(5);
    const gate = createReportGate();
    const admitted = Array.from({ length: 9 }, (_, i) => gate.admit(r(`m${i}`)));
    expect(admitted.filter(Boolean)).toHaveLength(5);
    expect(admitted.slice(0, 5).every(Boolean)).toBe(true);
  });

  it("does not spend the budget on duplicates", () => {
    const gate = createReportGate(2);
    expect(gate.admit(r("a"))).toBe(true);
    expect(gate.admit(r("a"))).toBe(false);
    expect(gate.admit(r("b"))).toBe(true);
    expect(gate.admit(r("c"))).toBe(false);
  });
});

describe("browserFamily", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "chrome",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      "edge",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0",
      "opera",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      "samsung",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
      "firefox",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "safari",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
      "chrome",
    ],
    ["curl/8.4.0", "other"],
    ["", "other"],
    [null, "other"],
  ])("%s -> %s", (ua, expected) => {
    expect(browserFamily(ua)).toBe(expected);
  });
});
