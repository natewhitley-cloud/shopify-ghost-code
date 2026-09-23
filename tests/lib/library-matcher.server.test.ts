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

  // gc-tus.12: floating dist-tags have no major; they are returned as a tag so
  // the duplicate detector can still count the copy.
  it.each(["latest", "next", "beta", "canary", "rc", "alpha"])(
    "returns a floating tag with an unknown major for @%s",
    (tag) => {
      expect(parseLibrary(`https://cdn.jsdelivr.net/npm/swiper@${tag}/swiper.js`)).toEqual({
        name: "swiper",
        major: null,
        tag,
      });
      expect(parseLibrary(`https://unpkg.com/swiper@${tag}/swiper.js`)).toEqual({
        name: "swiper",
        major: null,
        tag,
      });
    },
  );

  it("lowercases a floating tag and handles scoped packages and a bare tag", () => {
    expect(parseLibrary("https://cdn.jsdelivr.net/npm/swiper@LATEST/x.js")).toEqual({
      name: "swiper",
      major: null,
      tag: "latest",
    });
    expect(parseLibrary("https://unpkg.com/@scope/pkg@next/dist/x.js")).toEqual({
      name: "@scope/pkg",
      major: null,
      tag: "next",
    });
    expect(parseLibrary("https://unpkg.com/swiper@latest")).toEqual({
      name: "swiper",
      major: null,
      tag: "latest",
    });
  });

  it("extracts the major from range-like versions (^1, ~2, >=1, 1.x, bare 3)", () => {
    // The URL parser percent-encodes `^` and `>` in the path (`%5E1`, `%3E=1`);
    // the major must come from the decoded version, not the escape's digits.
    const major = (v: string) => parseLibrary(`https://cdn.jsdelivr.net/npm/swiper@${v}/x.js`);
    expect(major("^1")).toEqual({ name: "swiper", major: 1 });
    expect(major("%5E1")).toEqual({ name: "swiper", major: 1 });
    expect(major("~2")).toEqual({ name: "swiper", major: 2 });
    expect(major(">=1")).toEqual({ name: "swiper", major: 1 });
    expect(major("1.x")).toEqual({ name: "swiper", major: 1 });
    expect(major("3")).toEqual({ name: "swiper", major: 3 });
    expect(major("8.0.0-beta.1")).toEqual({ name: "swiper", major: 8 });
  });

  // Owner decision 1A: only the conventional dist-tags count. Anything else
  // without a digit (@x, @v, @main, custom tags, typos) is unparseable, as it
  // was before gc-tus.12, so it can never mint a duplicate finding.
  it.each(["x", "v", "main", "stable", "lts", "dev", "latest.", "late-st", "foo"])(
    "returns null for an unknown non-numeric version @%s",
    (v) => {
      expect(parseLibrary(`https://cdn.jsdelivr.net/npm/swiper@${v}/x.js`)).toBeNull();
      expect(parseLibrary(`https://unpkg.com/swiper@${v}/x.js`)).toBeNull();
    },
  );

  it("returns null for a version that is neither numeric nor a tag", () => {
    expect(parseLibrary("https://cdn.jsdelivr.net/npm/swiper@*/x.js")).toBeNull();
    expect(parseLibrary("https://cdn.jsdelivr.net/npm/swiper@%ZZ/x.js")).toBeNull();
  });

  it("never treats a cdnjs non-numeric segment as a floating tag", () => {
    expect(parseLibrary("https://cdnjs.cloudflare.com/ajax/libs/jquery/latest/x.js")).toBeNull();
    expect(parseLibrary("https://cdnjs.cloudflare.com/ajax/libs/jquery/jquery.min.js")).toBeNull();
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

  it("is unchanged for floating and range-like versions (gc-tus.12)", () => {
    for (const v of ["latest", "next", "beta", "canary", "^1", "~2", "3"]) {
      expect(isBenignLibrary(`https://cdn.jsdelivr.net/npm/swiper@${v}/x.js`)).toBe(true);
      expect(isBenignLibrary(`https://unpkg.com/swiper@${v}/x.js`)).toBe(true);
      expect(isBenignLibrary(`https://cdn.jsdelivr.net/npm/evil-tracker@${v}/x.js`)).toBe(false);
    }
  });
});

// Google Merchant Center store widget: a hand-pasted Google script, not an app,
// so it can never be "uninstalled". It must be benign (not an unknown script),
// NOT an app signature (which would mint a false "safe-to-remove" GHOST_SCRIPT
// and GHOST_LAYOUT). Adversarial audit 2026-09-23.
describe("isBenignLibrary: exact benign script paths", () => {
  it("treats the Merchant Center widget as benign (http/https, protocol-relative, query)", () => {
    expect(isBenignLibrary("https://www.gstatic.com/shopping/merchant/merchantwidget.js")).toBe(
      true,
    );
    expect(isBenignLibrary("//www.gstatic.com/shopping/merchant/merchantwidget.js?x=1")).toBe(true);
  });

  it("does not bless other gstatic paths or lookalike hosts", () => {
    expect(isBenignLibrary("https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js")).toBe(
      false,
    );
    expect(isBenignLibrary("https://evil.com/shopping/merchant/merchantwidget.js")).toBe(false);
    expect(
      isBenignLibrary("https://www.gstatic.com/shopping/merchant/merchantwidget.js.evil.js"),
    ).toBe(false);
  });
});
