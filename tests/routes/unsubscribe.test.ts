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
import { action as indexAction, loader as indexLoader } from "../../app/routes/unsubscribe._index";

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
    // The form POSTs to /unsubscribe with the token in the BODY (hidden input).
    expect(html).toContain('<form method="post" action="/unsubscribe">');
    expect(html).toContain('name="token"');
    expect(html).toContain("<noscript>");
    expect(html).toContain("Ghost Code > Settings");
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

  it("a rotated token is dead: the second use shows the invalid page", async () => {
    // disableAlertsByToken nulls the token on success, so the second call matches nothing.
    mockDisable.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await post()).status).toBe(200);
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This link is invalid or has expired");
  });

  it("a body token wins over the path token", async () => {
    await post("path-token", "token=body-token");
    expect(mockDisable).toHaveBeenCalledExactlyOnceWith("body-token");
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

describe("/unsubscribe (token in the body, gc-252x)", () => {
  const postIndex = (body: string, headers: Record<string, string> = {}) =>
    indexAction({
      request: new Request("https://app.test/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body,
      }),
      params: {},
      context: {},
    } as ActionFunctionArgs);

  it("GET renders the same static confirm page and changes nothing", async () => {
    const res = await indexLoader();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(await (await loader()).text());
    expect(mockDisable).not.toHaveBeenCalled();
    expectPrivateHeaders(res);
  });

  it("POST with a body token disables", async () => {
    const res = await postIndex(`token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockDisable).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(await res.text()).toContain("Monitoring emails are off");
  });

  it("POST with no token reports invalid and never matches a NULL column", async () => {
    mockDisable.mockResolvedValue(false);
    const res = await postIndex("");
    expect(res.status).toBe(404);
    expect(mockDisable).toHaveBeenCalledExactlyOnceWith("");
  });

  it("an oversized body is ignored rather than read", async () => {
    mockDisable.mockResolvedValue(false);
    const res = await postIndex(`token=${"x".repeat(5000)}`, { "content-length": "5006" });
    expect(res.status).toBe(404);
    expect(mockDisable).toHaveBeenCalledExactlyOnceWith("");
  });

  it("a database error renders a generic page without the token", async () => {
    mockDisable.mockRejectedValue(new Error(`boom ${TOKEN}`));
    const res = await postIndex(`token=${TOKEN}`);
    const html = await res.text();
    expect(res.status).toBe(500);
    expect(html).not.toContain(TOKEN);
  });

  it("rejects non-POST mutations with 405", async () => {
    const res = await indexAction({
      request: new Request("https://app.test/unsubscribe", { method: "PUT", body: "x=1" }),
      params: {},
      context: {},
    } as ActionFunctionArgs);
    expect(res.status).toBe(405);
    expect(mockDisable).not.toHaveBeenCalled();
  });
});

describe("confirm page inline script", () => {
  // Run the page's real script against a fake location/document and capture the result.
  async function runScript(location: { hash: string; pathname: string }) {
    const html = await (await indexLoader()).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const input = { value: "" };
    const replaceState = vi.fn();
    new Function("location", "document", "history", script)(
      location,
      { getElementById: (id: string) => (id === "token" ? input : null) },
      { replaceState },
    );
    return { value: input.value, replaceState };
  }

  it("reads the token from the fragment and clears it from the address bar", async () => {
    const r = await runScript({ hash: `#t=${TOKEN}`, pathname: "/unsubscribe" });
    expect(r.value).toBe(TOKEN);
    expect(r.replaceState).toHaveBeenCalledWith(null, "", "/unsubscribe");
  });

  it("reads a legacy /unsubscribe/<token> path and clears it", async () => {
    const r = await runScript({ hash: "", pathname: `/unsubscribe/${TOKEN}` });
    expect(r.value).toBe(TOKEN);
    expect(r.replaceState).toHaveBeenCalledWith(null, "", "/unsubscribe");
  });

  it("leaves the field empty when there is no token", async () => {
    const r = await runScript({ hash: "", pathname: "/unsubscribe" });
    expect(r.value).toBe("");
    expect(r.replaceState).not.toHaveBeenCalled();
  });

  it("is self-contained: no external resources", async () => {
    const html = await (await indexLoader()).text();
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
