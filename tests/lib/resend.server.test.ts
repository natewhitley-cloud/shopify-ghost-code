import { describe, it, expect, vi, afterEach } from "vitest";

import {
  postResendEmail,
  RESEND_ENDPOINT,
  RESEND_SEND_TIMEOUT_MS,
} from "../../app/lib/resend.server";

describe("postResendEmail (gc-v5p7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the JSON payload with auth, extra headers and a timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await postResendEmail(
      "re_key",
      { from: "a@x.com", to: "b@y.com" },
      { "Idempotency-Key": "k1" },
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Idempotency-Key": "k1",
      Authorization: "Bearer re_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ from: "a@x.com", to: "b@y.com" });
    expect(timeout).toHaveBeenCalledWith(RESEND_SEND_TIMEOUT_MS);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("caller headers cannot override auth or content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await postResendEmail(
      "re_key",
      {},
      {
        Authorization: "Bearer other",
        authorization: "Bearer evil",
        "CONTENT-TYPE": "text/plain",
        "Content-Type": "text/plain",
      },
    );
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer re_key",
      "Content-Type": "application/json",
    });
  });

  it("rejects on a network error (callers catch)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(postResendEmail("k", {})).rejects.toThrow("fetch failed");
  });
});
