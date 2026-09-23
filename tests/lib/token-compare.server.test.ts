import { describe, it, expect } from "vitest";

import { timingSafeTokenMatch } from "../../app/lib/token-compare.server";

describe("timingSafeTokenMatch", () => {
  it("is true for equal strings", () => {
    expect(timingSafeTokenMatch("secret-token", "secret-token")).toBe(true);
  });

  it("is false for different strings of the same length", () => {
    expect(timingSafeTokenMatch("secret-token", "secret-tokeX")).toBe(false);
  });

  it("is false for different-length strings", () => {
    expect(timingSafeTokenMatch("short", "much-longer-value")).toBe(false);
  });

  it("is false when the received value is null (missing header)", () => {
    expect(timingSafeTokenMatch(null, "secret-token")).toBe(false);
  });
});
