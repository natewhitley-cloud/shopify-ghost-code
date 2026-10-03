import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { logger } from "../../app/lib/logger.server";
import { scrubContext } from "../../app/lib/scrub";

// The REAL scrub runs here (no mocks): gc-t7o2 (ported from FraudPilot ft-h6o) routes every logger entry through
// it, so a direct logger.* call can never bypass the PII redaction boundary.

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Parse the single JSON line the logger wrote to a console spy. */
function entry(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(String(spy.mock.calls[0][0]));
}

describe("logger — PII scrub on every entry (gc-t7o2)", () => {
  it.each([
    ["email", { email: "buyer@example.com" }],
    ["clientIp", { clientIp: "203.0.113.7" }],
    ["accessToken", { accessToken: "shpat_abc" }],
    ["authorization", { authorization: "Bearer x" }],
  ])("redacts the value of a sensitive %s key", (_label, meta) => {
    logger.info("msg", meta);
    const key = Object.keys(meta)[0];
    expect(entry(log)[key]).toBe("[REDACTED]");
  });

  it("scrubs an email and IP embedded in a non-sensitive meta value", () => {
    logger.warn("msg", { detail: "from buyer@example.com at 203.0.113.7" });
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain("buyer@example.com");
    expect(line).not.toContain("203.0.113.7");
    expect(entry(warn).detail).toBe("from [REDACTED] at [REDACTED]");
  });

  it("scrubs nested meta (objects and arrays)", () => {
    logger.info("msg", {
      order: { buyer: { email: "a@b.co" }, notes: ["ip 198.51.100.2"] },
    });
    const line = String(log.mock.calls[0][0]);
    expect(line).not.toContain("a@b.co");
    expect(line).not.toContain("198.51.100.2");
  });

  it("scrubs PII in the message itself", () => {
    logger.error("lookup failed for buyer@example.com");
    expect(entry(error).message).toBe("lookup failed for [REDACTED]");
  });

  it("scrubs an Error's message and stack", () => {
    const err = new Error("unique constraint on email buyer@example.com");
    err.stack = `Error: buyer@example.com\n    at 203.0.113.7`;
    logger.error("db write failed", { error: err });
    const line = String(error.mock.calls[0][0]);
    expect(line).not.toContain("buyer@example.com");
    expect(line).not.toContain("203.0.113.7");
    const e = entry(error).error as Record<string, string>;
    expect(e.name).toBe("Error");
    expect(e.message).toBe("unique constraint on email [REDACTED]");
  });

  it("keeps a string error a string, scrubbed (the common err.message call)", () => {
    logger.error("boom", { error: "failed for buyer@example.com" });
    expect(entry(error).error).toBe("failed for [REDACTED]");
  });

  it("scrubs a non-Error, non-string error value", () => {
    logger.error("boom", { error: { detail: "buyer@example.com" } });
    expect(entry(error).error).toEqual({ detail: "[REDACTED]" });
  });

  it("keeps the operational fields scan/webhook/billing logs rely on intact", () => {
    const meta = {
      shop: "example.myshopify.com",
      topic: "APP_UNINSTALLED",
      scanId: "clx123",
      themeId: "gid://shopify/OnlineStoreTheme/1",
      fromPlan: "FREE",
      toPlan: "PRO",
      skipped: 2,
      skippedFiles: ["snippets/old-app.liquid"],
      skippedCategories: { vendor: 1 },
      benignLibrarySkips: 3,
      unknownScriptCount: 1,
      activeSubscriptionCount: 1,
      hasRefreshToken: true,
      tokenExpired: false,
    };
    logger.info("Scan complete", meta);
    expect(entry(log)).toMatchObject({ level: "info", message: "Scan complete", ...meta });
  });

  it("routes levels to console.log / warn / error", () => {
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(entry(log).level).toBe("info");
    expect(entry(warn).level).toBe("warn");
    expect(entry(error).level).toBe("error");
  });

  it("never throws on a circular or throwing-getter meta", () => {
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    const getter = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(() => logger.info("c", circ)).not.toThrow();
    expect(() => logger.info("g", { nested: getter })).not.toThrow();
  });
});

describe("URL query-param scrub (SSR-failure request.url)", () => {
  const EMBEDDED_URL =
    "https://app.example.com/app/review/abc?embedded=1&hmac=deadbeef&host=YWRtaW4&id_token=eyJhbGciOi.payload.sig&locale=en&session=sess123&shop=example.myshopify.com&timestamp=1759440000";

  it("redacts id_token, hmac and session in a logged URL, keeps the rest", () => {
    logger.error("Server-side render failed", { url: EMBEDDED_URL });
    const url = entry(error).url as string;
    expect(url).not.toContain("eyJhbGciOi");
    expect(url).not.toContain("deadbeef");
    expect(url).not.toContain("sess123");
    expect(url).toBe(
      "https://app.example.com/app/review/abc?embedded=1&hmac=[REDACTED]&host=YWRtaW4&id_token=[REDACTED]&locale=en&session=[REDACTED]&shop=example.myshopify.com&timestamp=1759440000",
    );
  });

  it("redacts a sensitive param that is first, last, or URL-encoded", () => {
    logger.info("u", {
      a: "/x?token=t1",
      b: "/x?a=1&access_token=t2#frag",
      c: "/x?id%5Ftoken=t3",
    });
    const e = entry(log);
    expect(e.a).toBe("/x?token=[REDACTED]");
    expect(e.b).toBe("/x?a=1&access_token=[REDACTED]#frag");
    expect(e.c).toBe("/x?id%5Ftoken=[REDACTED]");
  });

  it("redacts a token param inside an error message", () => {
    logger.error("fetch failed", {
      error: new Error("GET /auth?id_token=eyJsecret failed"),
    });
    expect(String(error.mock.calls[0][0])).not.toContain("eyJsecret");
  });

  it("leaves non-sensitive params and plain text alone", () => {
    logger.info("u", { url: "/app/review-queue?page=2&sort=age", note: "a=b" });
    expect(entry(log)).toMatchObject({
      url: "/app/review-queue?page=2&sort=age",
      note: "a=b",
    });
  });
});

describe("logger never throws (FraudPilot ft-edm M1)", () => {
  it("does not throw on a deeply nested message (bounded recursion)", () => {
    expect(() => logger.error("?x=" + "?a=".repeat(2000))).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

it("drops to a marker line when serializing the error throws (FraudPilot ft-edm M1)", () => {
  const bad = new Error("x");
  Object.defineProperty(bad, "message", {
    get() {
      throw new Error("boom");
    },
  });
  expect(() => logger.error("failed", { error: bad })).not.toThrow();
  expect(entry(error).message).toBe("[log entry dropped: scrub failed]");
});

describe("logger never throws on unserializable preserved keys (gc-t7o2 audit L4)", () => {
  it("drops to a marker line when a preserved key holds a BigInt", () => {
    expect(() => logger.info("x", { shopId: 1n })).not.toThrow();
    expect(entry(log).message).toBe("[log entry dropped: serialize failed]");
  });

  it("drops to a marker line when the context has a throwing getter", () => {
    const ctx = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(() => logger.warn("x", ctx)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("log meta size cap (FraudPilot ft-edm audit M3)", () => {
  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(22, "0")}`);

  it("keeps meta between 8 KB and 32 KB intact", () => {
    const meta = { findingIds: ids("fi", 200), scanIds: ids("sc", 200) };
    expect(JSON.stringify(meta).length).toBeGreaterThan(8 * 1024);
    logger.warn("holdings", meta);
    const line = entry(warn);
    expect(line._truncated).toBeUndefined();
    expect(line.scanIds).toEqual(meta.scanIds);
  });

  it("still truncates meta over the 32 KB log cap", () => {
    logger.warn("huge", { findingIds: ids("fi", 2000) });
    expect(entry(warn)._truncated).toBe(true);
  });

  it("leaves scrubContext's default cap at 8 KB", () => {
    expect(scrubContext({ findingIds: ids("fi", 400) })._truncated).toBe(true);
  });
});
