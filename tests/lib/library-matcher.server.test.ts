import { describe, it, expect } from "vitest";

import { isBenignLibrary, parseLibrary } from "../../app/lib/library-matcher.server";

// ---------------------------------------------------------------------------
// parseLibrary — public-CDN name + major extraction
// ---------------------------------------------------------------------------

describe("parseLibrary", () => {
  it("parses a jsdelivr /npm/<name>@<version> URL", () => {
    expect(parseLibrary("https://cdn.jsdelivr.net/npm/swiper@11.0.5/swiper-bundle.min.js")).toEqual(
      { name: "swiper", major: 11 },
    );
  });

  it("parses an unpkg /<name>@<version> URL", () => {
    expect(parseLibrary("https://unpkg.com/vanilla-lazyload@17.8.3/dist/lazyload.min.js")).toEqual({
      name: "vanilla-lazyload",
      major: 17,
    });
  });

  it("parses a cdnjs /ajax/libs/<name>/<version> URL", () => {
    expect(
      parseLibrary("https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"),
    ).toEqual({ name: "jquery", major: 3 });
  });

  it("extracts the major from a bare major version and a v-prefixed version", () => {
    expect(parseLibrary("https://cdn.jsdelivr.net/npm/swiper@8/swiper.js")).toEqual({
      name: "swiper",
      major: 8,
    });
    expect(
      parseLibrary("https://cdnjs.cloudflare.com/ajax/libs/jquery/v3.6.0/jquery.min.js"),
    ).toEqual({ name: "jquery", major: 3 });
  });

  it("normalizes protocol-relative URLs", () => {
    expect(parseLibrary("//cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js")).toEqual({
      name: "lodash",
      major: 4,
    });
  });

  it("returns null for non-CDN hosts", () => {
    expect(parseLibrary("https://cdn.unknownapp.com/swiper@11/widget.js")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parseLibrary("not a url")).toBeNull();
  });

  it("returns null when the CDN URL carries no version boundary", () => {
    expect(parseLibrary("https://unpkg.com/swiper/dist/swiper.js")).toBeNull();
  });

  it("returns null when the version has no leading digit (e.g. @latest)", () => {
    expect(parseLibrary("https://cdn.jsdelivr.net/npm/swiper@latest/swiper.js")).toBeNull();
  });

  it("returns null for a jsdelivr non-/npm path (e.g. /gh/)", () => {
    expect(parseLibrary("https://cdn.jsdelivr.net/gh/user/repo@1.0.0/x.js")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isBenignLibrary — refactor must preserve existing behavior
// ---------------------------------------------------------------------------

describe("isBenignLibrary (behavior preserved after parseLibrary refactor)", () => {
  it("recognizes a jsdelivr seed-list package", () => {
    expect(isBenignLibrary("https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js")).toBe(
      true,
    );
  });

  it("recognizes an unpkg seed-list package", () => {
    expect(isBenignLibrary("https://unpkg.com/vanilla-lazyload@17.8.3/dist/lazyload.min.js")).toBe(
      true,
    );
  });

  it("recognizes a font host by hostname", () => {
    expect(isBenignLibrary("https://fonts.googleapis.com/css2?family=Inter")).toBe(true);
  });

  it("does not recognize a non-seed-list package on a shared CDN", () => {
    expect(isBenignLibrary("https://cdn.jsdelivr.net/npm/evil-tracker@1/x.js")).toBe(false);
  });

  it("does not match a lookalike package name (version boundary preserved)", () => {
    expect(isBenignLibrary("https://cdn.jsdelivr.net/npm/swiperevil@1/x.js")).toBe(false);
  });

  it("does not suppress cdnjs (never a suppression source)", () => {
    expect(
      isBenignLibrary("https://cdnjs.cloudflare.com/ajax/libs/swiper/11.0.0/swiper.min.js"),
    ).toBe(false);
  });

  it("returns false for a malformed URL", () => {
    expect(isBenignLibrary("not a url")).toBe(false);
  });
});
