import { describe, expect, it } from "vitest";

import {
  homeScanStartPayload,
  parseScanSource,
  SCAN_PAGE_RESCAN_PAYLOAD,
  SCAN_SOURCES,
} from "../../app/lib/scan-source";

describe("parseScanSource", () => {
  it.each(["home", "scan_page", "unknown"])("keeps the allowlisted value %s", (value) => {
    expect(parseScanSource(value)).toBe(value);
  });

  it("maps a missing field (null) to unknown", () => {
    expect(parseScanSource(null)).toBe("unknown");
  });

  it("maps undefined to unknown", () => {
    expect(parseScanSource(undefined)).toBe("unknown");
  });

  it("maps a File upload (non-string form value) to unknown", () => {
    expect(parseScanSource(new File(["home"], "home"))).toBe("unknown");
  });

  it.each([
    "",
    " ",
    "garbage",
    "HOME",
    "Home",
    " home",
    "home ",
    "home\n",
    "scan-page",
    "scanpage",
    "settings",
    "home,scan_page",
    'home\'; DROP TABLE "Scan"; --',
    "<script>alert(1)</script>",
    "__proto__",
    "constructor",
    "toString",
    "x".repeat(10_000),
  ])("maps the unrecognized value %j to unknown", (value) => {
    expect(parseScanSource(value)).toBe("unknown");
  });
});

describe("scan-start form payloads", () => {
  it("Home's payload carries the chosen theme and source=home", () => {
    expect(homeScanStartPayload("gid://shopify/OnlineStoreTheme/1")).toEqual({
      themeId: "gid://shopify/OnlineStoreTheme/1",
      source: SCAN_SOURCES.HOME,
    });
  });

  it("the scan page's rescan payload carries source=scan_page and no theme (main theme)", () => {
    expect(SCAN_PAGE_RESCAN_PAYLOAD).toEqual({ source: SCAN_SOURCES.SCAN_PAGE });
  });

  it("every payload source survives the action's allowlist unchanged", () => {
    expect(parseScanSource(homeScanStartPayload("t").source)).toBe("home");
    expect(parseScanSource(SCAN_PAGE_RESCAN_PAYLOAD.source)).toBe("scan_page");
  });
});
