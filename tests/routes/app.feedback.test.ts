/**
 * /app/feedback (removed in gc-3twe) redirects to the Help page's feedback
 * topic (gc-7f1p), so old bookmarks and cached nudge links don't 404.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));

import { loader } from "../../app/routes/app.feedback";
import { authenticate } from "../../app/shopify.server";

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;

async function load(url: string): Promise<Response> {
  try {
    const result = await loader({ request: new Request(url), params: {}, context: {} } as never);
    return result as Response;
  } catch (thrown) {
    return thrown as Response;
  }
}

describe("app.feedback loader (gc-7f1p)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateAdmin.mockResolvedValue({ session: { shop: "s.myshopify.com" } });
  });

  it("authenticates, then redirects to Help with topic=feedback, keeping src and embedded params", async () => {
    const res = await load(
      "https://app.example.com/app/feedback?src=nudge&host=abc&shop=s.myshopify.com&embedded=1",
    );
    expect(mockAuthenticateAdmin).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!, "https://app.example.com");
    expect(location.pathname).toBe("/app/help");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      src: "nudge",
      host: "abc",
      shop: "s.myshopify.com",
      embedded: "1",
      topic: "feedback",
    });
  });

  it("overrides any topic already on the URL and stays on this origin", async () => {
    const res = await load("https://app.example.com/app/feedback?topic=bug");
    const location = res.headers.get("Location")!;
    expect(location.startsWith("/app/help?")).toBe(true);
    expect(new URL(location, "https://x.test").searchParams.getAll("topic")).toEqual(["feedback"]);
  });

  it("an unauthenticated request never reaches the redirect", async () => {
    const authRedirect = new Response(null, { status: 302, headers: { Location: "/auth/login" } });
    mockAuthenticateAdmin.mockRejectedValue(authRedirect);
    const res = await load("https://app.example.com/app/feedback");
    expect(res).toBe(authRedirect);
  });
});
