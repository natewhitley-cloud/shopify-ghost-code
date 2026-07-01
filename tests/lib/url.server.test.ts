import { describe, it, expect } from "vitest";

import { hostnameFromUrl } from "../../app/lib/url.server";

describe("hostnameFromUrl", () => {
  it("extracts the hostname from an https URL", () => {
    expect(hostnameFromUrl("https://cdn.example.com/path/to/file.js")).toBe("cdn.example.com");
  });

  it("extracts the hostname from an http URL", () => {
    expect(hostnameFromUrl("http://example.com/x.js")).toBe("example.com");
  });

  it("normalizes protocol-relative URLs by assuming https", () => {
    expect(hostnameFromUrl("//fast.klaviyo.com/x.js")).toBe("fast.klaviyo.com");
  });

  it("strips the port from a host with a port", () => {
    expect(hostnameFromUrl("https://example.com:8443/x.js")).toBe("example.com");
  });

  it("lowercases an uppercase host", () => {
    expect(hostnameFromUrl("https://CDN.EXAMPLE.COM/x.js")).toBe("cdn.example.com");
  });

  it("returns null for bare/garbage input", () => {
    expect(hostnameFromUrl("not-a-url")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(hostnameFromUrl("")).toBeNull();
  });
});
