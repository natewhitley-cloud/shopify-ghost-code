/**
 * Tests for app/services/speed-leftovers.server.ts (gc-np1d.6): the leftover
 * counts behind Store speed's "See its N leftovers" link. The real
 * value-action counting runs (leftover types only, never security); the reads
 * are mocked at the model / theme boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../app/services/theme-cache.server", () => ({ getCachedMainTheme: vi.fn() }));
vi.mock("../../app/models/scan.server", () => ({ getLatestSuccessfulScanIdForTheme: vi.fn() }));
vi.mock("../../app/models/ignored-finding.server", () => ({
  getIgnoredFindingsForShop: vi.fn(),
}));
vi.mock("../../app/models/finding.server", () => ({
  countFindingsByApp: vi.fn(),
  getFindingsForScan: vi.fn(),
}));

import { countFindingsByApp, getFindingsForScan } from "../../app/models/finding.server";
import { getIgnoredFindingsForShop } from "../../app/models/ignored-finding.server";
import { getLatestSuccessfulScanIdForTheme } from "../../app/models/scan.server";
import { fingerprintFinding } from "../../app/services/scan-differ.server";
import { readSpeedAppLeftovers } from "../../app/services/speed-leftovers.server";
import { getCachedMainTheme } from "../../app/services/theme-cache.server";
import type { AdminApiContext } from "../../app/types/shopify";

const mockTheme = getCachedMainTheme as ReturnType<typeof vi.fn>;
const mockScanId = getLatestSuccessfulScanIdForTheme as ReturnType<typeof vi.fn>;
const mockIgnores = getIgnoredFindingsForShop as ReturnType<typeof vi.fn>;
const mockCounts = countFindingsByApp as ReturnType<typeof vi.fn>;
const mockFindings = getFindingsForScan as ReturnType<typeof vi.fn>;

const ADMIN = {} as AdminApiContext;
const THEME = "gid://shopify/Theme/1";
const NO_IGNORES = { fingerprints: new Set<string>(), appNames: new Set<string>() };

function read(appNames: string[] = ["Klaviyo"]) {
  return readSpeedAppLeftovers({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    admin: ADMIN,
    appNames,
  });
}

function finding(appName: string, findingType: string, n = 1) {
  return {
    id: `${appName}-${findingType}-${n}`,
    appName,
    findingType,
    filename: `snippets/${appName}-${n}.liquid`,
    codeSnippet: `<script src="${appName}-${n}.js"></script>`,
    lineNumber: n,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockTheme.mockResolvedValue({ id: THEME, name: "Dawn", updatedAt: new Date() });
  mockScanId.mockResolvedValue("scan-9");
  mockIgnores.mockResolvedValue(NO_IGNORES);
  mockCounts.mockResolvedValue([]);
});

describe("readSpeedAppLeftovers", () => {
  it("counts leftover types of the live theme's latest successful scan, for the named apps only", async () => {
    mockCounts.mockResolvedValue([
      { appName: "Klaviyo", findingType: "GHOST_SCRIPT", count: 2 },
      { appName: "Klaviyo", findingType: "GHOST_SNIPPET", count: 1 },
      { appName: "Klaviyo", findingType: "MALICIOUS_SCRIPT", count: 5 },
      { appName: "Recharge", findingType: "GHOST_SCRIPT", count: 7 },
      { appName: null, findingType: "GHOST_SCRIPT", count: 4 },
    ]);
    expect(await read([" klaviyo "])).toEqual({
      scanId: "scan-9",
      apps: [{ name: "Klaviyo", count: 3 }],
    });
    expect(mockTheme).toHaveBeenCalledWith(ADMIN, "x.myshopify.com");
    expect(mockScanId).toHaveBeenCalledWith("shop-1", THEME);
    expect(mockCounts).toHaveBeenCalledWith("scan-9");
    expect(mockFindings).not.toHaveBeenCalled();
  });

  it.each(["MALICIOUS_SCRIPT", "APP_INCIDENT_ADVISORY", "MENU_INJECTION"])(
    "an app with only security findings (%s) has no leftovers",
    async (type) => {
      mockCounts.mockResolvedValue([{ appName: "Klaviyo", findingType: type, count: 3 }]);
      expect(await read()).toBeNull();
    },
  );

  it("no named app: nothing is read", async () => {
    expect(await read([])).toBeNull();
    expect(mockTheme).not.toHaveBeenCalled();
    expect(mockScanId).not.toHaveBeenCalled();
    expect(mockIgnores).not.toHaveBeenCalled();
  });

  it("no live theme, or no successful scan of it: null", async () => {
    mockTheme.mockResolvedValueOnce(null);
    expect(await read()).toBeNull();
    expect(mockScanId).not.toHaveBeenCalled();
    mockScanId.mockResolvedValueOnce(null);
    expect(await read()).toBeNull();
    expect(mockCounts).not.toHaveBeenCalled();
  });

  it.each([
    ["the theme read", () => mockTheme.mockRejectedValue(new Error("api down"))],
    ["the scan read", () => mockScanId.mockRejectedValue(new Error("db down"))],
    ["the ignores read", () => mockIgnores.mockRejectedValue(new Error("db down"))],
    ["the count read", () => mockCounts.mockRejectedValue(new Error("db down"))],
  ])("a failure in %s: null, never throws", async (_what, fail) => {
    mockCounts.mockResolvedValue([{ appName: "Klaviyo", findingType: "GHOST_SCRIPT", count: 2 }]);
    fail();
    await expect(read()).resolves.toBeNull();
  });

  it("an app ignore leaves that app out (no link)", async () => {
    mockIgnores.mockResolvedValue({ fingerprints: new Set(), appNames: new Set(["Klaviyo"]) });
    mockFindings.mockResolvedValue([finding("Klaviyo", "GHOST_SCRIPT", 1)]);
    expect(await read()).toBeNull();
    expect(mockCounts).not.toHaveBeenCalled();
  });

  it("an ignored finding is not counted", async () => {
    const ignored = finding("Klaviyo", "GHOST_SCRIPT", 1);
    mockIgnores.mockResolvedValue({
      fingerprints: new Set([
        fingerprintFinding(
          ignored.filename,
          "GHOST_SCRIPT",
          ignored.codeSnippet,
          ignored.lineNumber,
        ),
      ]),
      appNames: new Set(),
    });
    mockFindings.mockResolvedValue([
      ignored,
      finding("Klaviyo", "GHOST_SCRIPT", 2),
      finding("Klaviyo", "GHOST_SNIPPET", 3),
    ]);
    expect(await read()).toEqual({ scanId: "scan-9", apps: [{ name: "Klaviyo", count: 2 }] });
    expect(mockFindings).toHaveBeenCalledWith("scan-9");
  });
});
