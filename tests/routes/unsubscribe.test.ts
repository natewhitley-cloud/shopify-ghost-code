/**
 * Tests for app/routes/unsubscribe.$token.tsx (gc-syz.7), calling the route's
 * loader/action directly. Request-handler behaviour (Origin/CSRF) is covered by
 * tests/unsubscribe.integration.test.ts.
 */

import type { ActionFunctionArgs } from "react-router";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/models/merchant-alert.server", () => ({
  disableAlertsByToken: vi.fn(),
}));

import { disableAlertsByToken } from "../../app/models/merchant-alert.server";
import { action, loader } from "../../app/routes/unsubscribe.$token";

const mockDisable = disableAlertsByToken as ReturnType<typeof vi.fn>;
const TOKEN = "tok_" + "a".repeat(39);

function args(method: string, token: string | undefined, body?: string) {
  return {
    request: new Request(`https://app.test/unsubscribe/${token ?? ""}`, {
      method,
      headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
      body,
    }),
    params: token === undefined ? {} : { token },
    context: {},
  };
}
const get = (token = TOKEN) => {
  // The loader ignores the request and params by design (no lookup on GET), so
  // the token is only here to prove that: the page is identical for any value.
  void token;
  return loader();
};
const post = (token: string | undefined = TOKEN, body = "List-Unsubscribe=One-Click") =>
  action(args("POST", token, body) as ActionFunctionArgs);

function expectPrivateHeaders(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  expect(res.headers.get("Content-Type")).toContain("text/html");
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDisable.mockResolvedValue(true);
});

describe("GET /unsubscribe/:token", () => {
  it("renders the confirm page with a POST form and changes nothing", async () => {
    const res = await get();
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Turn off Ghost Code monitoring emails for this store?");
    expect(html).toContain('<form method="post" action="">');
    expect(mockDisable).not.toHaveBeenCalled();
    expectPrivateHeaders(res);
  });

  it("never puts the token in the page", async () => {
    expect(await (await get()).text()).not.toContain(TOKEN);
  });

  it("renders the same page for any token (no lookup, so no oracle)", async () => {
    const a = await (await get(TOKEN)).text();
    const b = await (await get("something-else")).text();
    expect(a).toBe(b);
    expect(mockDisable).not.toHaveBeenCalled();
  });
});

describe("POST /unsubscribe/:token", () => {
  it("valid token: disables alerts and shows the confirmation", async () => {
    const res = await post();
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(mockDisable).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(html).toContain("Monitoring emails are off");
    expect(html).toContain("You can turn them back on in Ghost Code > Settings.");
    expectPrivateHeaders(res);
  });

  it("accepts the RFC 8058 one-click body and an empty body alike", async () => {
    expect((await post(TOKEN, "List-Unsubscribe=One-Click")).status).toBe(200);
    expect((await post(TOKEN, "")).status).toBe(200);
  });

  it("is idempotent: a second POST still reports off", async () => {
    await post();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Monitoring emails are off");
  });

  it.each([
    ["unknown", "nope"],
    ["empty", ""],
    ["missing", undefined],
    ["oversized", "x".repeat(5000)],
  ])("%s token: invalid-link copy, 404", async (_l, token) => {
    mockDisable.mockResolvedValue(false);

    const res = await post(token as string | undefined);
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(html).toContain("This link is invalid or has expired");
    expect(html).not.toContain("Monitoring emails are off");
    expectPrivateHeaders(res);
  });

  it("a database error renders a generic page and does not leak the token or error", async () => {
    mockDisable.mockRejectedValue(new Error(`boom ${TOKEN}`));

    const res = await post();
    const html = await res.text();

    expect(res.status).toBe(500);
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("boom");
    expectPrivateHeaders(res);
  });

  it("rejects non-POST mutations with 405 and changes nothing", async () => {
    const res = await action(args("PUT", TOKEN, "x=1") as ActionFunctionArgs);
    expect(res.status).toBe(405);
    expect(mockDisable).not.toHaveBeenCalled();
  });
});
