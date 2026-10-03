import morgan from "morgan";
import { describe, it, expect } from "vitest";

import { REQUEST_LOG_FORMAT, pathOnly, registerPathToken } from "../../server/request-log.mjs";

describe("request log (gc-t7o2)", () => {
  it.each([
    ["/app?embedded=1&hmac=deadbeef&id_token=eyJsecret&session=s1", "/app"],
    ["/app/review/abc?src=setup_guide", "/app/review/abc"],
    ["/health", "/health"],
    ["/?", "/"],
    // The alert-unsubscribe token rides in the path: masked, query or not.
    ["/unsubscribe/3f9a0c7e1b", "/unsubscribe/[REDACTED]"],
    ["/unsubscribe/3f9a0c7e1b?utm=x", "/unsubscribe/[REDACTED]"],
    ["/unsubscribe/3f9a0c7e1b/extra", "/unsubscribe/[REDACTED]/extra"],
    // The confirm form POSTs to bare /unsubscribe (token in the body).
    ["/unsubscribe", "/unsubscribe"],
    ["/unsubscribe/", "/unsubscribe/"],
    ["/app/unsubscribe/x", "/app/unsubscribe/x"],
    [undefined, "-"],
  ])("pathOnly(%s) -> %s", (input, out) => {
    expect(pathOnly(input as string)).toBe(out);
  });

  it("formats a line without the query string (originalUrl wins)", () => {
    registerPathToken(morgan);
    const line = morgan.compile(REQUEST_LOG_FORMAT)(
      morgan as never,
      {
        method: "GET",
        url: "/rewritten",
        originalUrl: "/app?hmac=deadbeef&id_token=eyJsecret",
        headers: {},
      } as never,
      { statusCode: 200, getHeader: () => "12", headersSent: true } as never,
    );
    expect(line).toMatch(/^GET \/app 200 12 - /);
    expect(line).not.toContain("eyJsecret");
    expect(line).not.toContain("deadbeef");
  });

  it("never logs an unsubscribe token from the path", () => {
    registerPathToken(morgan);
    const line = morgan.compile(REQUEST_LOG_FORMAT)(
      morgan as never,
      {
        method: "POST",
        url: "/unsubscribe/tok-secret-256",
        originalUrl: "/unsubscribe/tok-secret-256",
        headers: {},
      } as never,
      { statusCode: 200, getHeader: () => "0", headersSent: true } as never,
    );
    expect(line).toMatch(/^POST \/unsubscribe\/\[REDACTED\] 200 /);
    expect(line).not.toContain("tok-secret-256");
  });
});
