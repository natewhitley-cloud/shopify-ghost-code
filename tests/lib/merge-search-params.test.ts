import { describe, expect, it } from "vitest";

import { mergeSearchParams } from "../../app/lib/merge-search-params";

describe("mergeSearchParams", () => {
  it("preserves existing embedded params while adding lane", () => {
    const current = new URLSearchParams({
      host: "abc123",
      embedded: "1",
      id_token: "tok",
      shop: "example.myshopify.com",
    });

    const result = new URLSearchParams(mergeSearchParams(current, { lane: "silent-drag" }));

    expect(result.get("host")).toBe("abc123");
    expect(result.get("embedded")).toBe("1");
    expect(result.get("id_token")).toBe("tok");
    expect(result.get("shop")).toBe("example.myshopify.com");
    expect(result.get("lane")).toBe("silent-drag");
  });

  it("overrides an already-present lane value instead of duplicating it", () => {
    const current = new URLSearchParams({ host: "abc123", lane: "old-lane" });

    const result = new URLSearchParams(mergeSearchParams(current, { lane: "new-lane" }));

    expect(result.getAll("lane")).toEqual(["new-lane"]);
    expect(result.get("host")).toBe("abc123");
  });

  it("does not mutate the source URLSearchParams", () => {
    const current = new URLSearchParams({ host: "abc123" });

    mergeSearchParams(current, { lane: "silent-drag" });

    expect(current.has("lane")).toBe(false);
    expect(current.get("host")).toBe("abc123");
  });

  it("URL-encodes override values correctly", () => {
    const current = new URLSearchParams({ host: "abc123" });

    const query = mergeSearchParams(current, { lane: "a b&c" });

    expect(query).toContain("lane=a+b%26c");
    expect(new URLSearchParams(query).get("lane")).toBe("a b&c");
  });
});
