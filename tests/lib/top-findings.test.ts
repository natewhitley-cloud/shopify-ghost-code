/**
 * Tests for app/lib/top-findings.ts (gc-bn0x): the one "Start here" ranking,
 * its diversity rule, and the block's presentation helpers.
 *
 * Consequence metadata used below (finding-consequence.ts):
 *   GHOST_SCRIPT     speed / act-now        GHOST_PRECONNECT speed / whenever
 *   GHOST_SNIPPET    customers / act-now    GHOST_SECTION    customers / whenever
 *   GHOST_PIXEL      privacy / act-now      GHOST_HREFLANG   discoverability / compounding
 *   ORPHAN_ASSET     housekeeping / whenever
 * Lane order: customers-see-it, discoverability, speed, privacy, housekeeping.
 */
import type { FindingType, Severity } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  compareFindingImportance,
  findingAnchorId,
  findingCostLine,
  findingLocation,
  pickTopFindings,
  TOP_FINDINGS_MAX,
  topFindingHref,
  toTopFindingViews,
} from "../../app/lib/top-findings";

function c(id: string, findingType: FindingType, severity: Severity, minute = 0) {
  return { id, findingType, severity, createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute)) };
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const sorted = (rows: ReturnType<typeof c>[]) => ids([...rows].sort(compareFindingImportance));

describe("compareFindingImportance", () => {
  it("puts MALICIOUS_SCRIPT first, even a LOW one above a HIGH finding", () => {
    expect(
      sorted([c("high", "GHOST_SNIPPET", "HIGH"), c("mal", "MALICIOUS_SCRIPT", "LOW")]),
    ).toEqual(["mal", "high"]);
  });

  it("then severity: HIGH > MEDIUM > LOW, whatever the urgency", () => {
    expect(
      sorted([
        c("low-actnow", "GHOST_SCRIPT", "LOW"),
        c("high-whenever", "ORPHAN_ASSET", "HIGH"),
        c("med-actnow", "GHOST_SNIPPET", "MEDIUM"),
      ]),
    ).toEqual(["high-whenever", "med-actnow", "low-actnow"]);
  });

  it("then consequence urgency: act-now > compounding > whenever", () => {
    expect(
      sorted([
        c("whenever", "GHOST_SECTION", "MEDIUM", 0),
        c("compounding", "GHOST_HREFLANG", "MEDIUM", 1),
        c("act-now", "GHOST_SCRIPT", "MEDIUM", 2),
      ]),
    ).toEqual(["act-now", "compounding", "whenever"]);
  });

  it("then lane order (customers, discoverability, speed, privacy, housekeeping)", () => {
    // All MEDIUM + act-now; lanes differ.
    expect(
      sorted([
        c("privacy", "GHOST_PIXEL", "MEDIUM", 0),
        c("speed", "GHOST_SCRIPT", "MEDIUM", 1),
        c("customers", "GHOST_SNIPPET", "MEDIUM", 2),
      ]),
    ).toEqual(["customers", "speed", "privacy"]);
  });

  it("then createdAt (oldest first), then id, so the order is total and stable", () => {
    const rows = [
      c("b", "GHOST_SCRIPT", "HIGH", 5),
      c("a", "GHOST_SCRIPT", "HIGH", 5),
      c("z", "GHOST_SCRIPT", "HIGH", 1),
    ];
    expect(sorted(rows)).toEqual(["z", "a", "b"]);
    expect(sorted([...rows].reverse())).toEqual(["z", "a", "b"]);
  });
});

describe("pickTopFindings", () => {
  it("returns at most 3, most important first", () => {
    const picked = pickTopFindings([
      c("l", "ORPHAN_ASSET", "LOW"),
      c("h", "GHOST_SNIPPET", "HIGH"),
      c("m", "GHOST_PIXEL", "MEDIUM"),
      c("h2", "GHOST_SCRIPT", "HIGH"),
    ]);
    expect(TOP_FINDINGS_MAX).toBe(3);
    expect(ids(picked)).toEqual(["h", "h2", "m"]);
  });

  it.each([
    [0, []],
    [1, ["a"]],
    [2, ["a", "b"]],
  ])("shows what exists when there are fewer than 3 (%i)", (n, expected) => {
    const rows = [c("a", "GHOST_SNIPPET", "HIGH", 0), c("b", "GHOST_PIXEL", "HIGH", 1)].slice(0, n);
    expect(ids(pickTopFindings(rows))).toEqual(expected);
  });

  it("diversity: skips a repeated type for another type of the same severity", () => {
    const picked = pickTopFindings([
      c("s1", "GHOST_SCRIPT", "HIGH", 0),
      c("s2", "GHOST_SCRIPT", "HIGH", 1),
      c("s3", "GHOST_SCRIPT", "HIGH", 2),
      // Ranks below every script (housekeeping / whenever) but same severity.
      c("orphan", "ORPHAN_ASSET", "HIGH", 3),
    ]);
    expect(ids(picked)).toEqual(["s1", "orphan", "s2"]);
  });

  it("diversity never lets a lower severity displace a higher one", () => {
    const picked = pickTopFindings([
      c("s1", "GHOST_SCRIPT", "HIGH", 0),
      c("s2", "GHOST_SCRIPT", "HIGH", 1),
      c("s3", "GHOST_SCRIPT", "HIGH", 2),
      c("snippet-med", "GHOST_SNIPPET", "MEDIUM", 0),
    ]);
    expect(ids(picked)).toEqual(["s1", "s2", "s3"]);
  });

  it("diversity picks the BEST row of the other types, in rank order", () => {
    const picked = pickTopFindings([
      c("s1", "GHOST_SCRIPT", "HIGH", 0),
      c("s2", "GHOST_SCRIPT", "HIGH", 1),
      c("orphan", "ORPHAN_ASSET", "HIGH", 0),
      c("pixel-new", "GHOST_PIXEL", "HIGH", 9),
      c("pixel-old", "GHOST_PIXEL", "HIGH", 8),
    ]);
    // s1; s2 is a repeat, so the best unpicked type (privacy before
    // housekeeping) takes slot 2; then s2 is still a repeat and orphan is the
    // best unpicked type left.
    expect(ids(picked)).toEqual(["s1", "pixel-old", "orphan"]);
  });

  it("malicious findings are exempt from diversity and always lead", () => {
    const picked = pickTopFindings([
      c("snippet", "GHOST_SNIPPET", "HIGH", 0),
      c("mal-1", "MALICIOUS_SCRIPT", "HIGH", 0),
      c("mal-2", "MALICIOUS_SCRIPT", "HIGH", 1),
      c("mal-3", "MALICIOUS_SCRIPT", "HIGH", 2),
    ]);
    expect(ids(picked)).toEqual(["mal-1", "mal-2", "mal-3"]);
  });

  it("a malicious pick does not count as a repeat for non-malicious types", () => {
    const picked = pickTopFindings([
      c("mal", "MALICIOUS_SCRIPT", "HIGH", 0),
      c("s1", "GHOST_SCRIPT", "HIGH", 0),
      c("s2", "GHOST_SCRIPT", "HIGH", 1),
    ]);
    expect(ids(picked)).toEqual(["mal", "s1", "s2"]);
  });

  it("is independent of input order and does not mutate the input", () => {
    const rows = [
      c("s1", "GHOST_SCRIPT", "HIGH", 0),
      c("s2", "GHOST_SCRIPT", "HIGH", 1),
      c("orphan", "ORPHAN_ASSET", "HIGH", 3),
      c("low", "GHOST_SNIPPET", "LOW", 0),
    ];
    const snapshot = [...rows];
    const expected = ids(pickTopFindings(rows));
    expect(ids(pickTopFindings([...rows].reverse()))).toEqual(expected);
    expect(rows).toEqual(snapshot);
  });

  it("returns the caller's objects", () => {
    const row = { ...c("x", "GHOST_SCRIPT", "LOW"), filename: "layout/theme.liquid" };
    expect(pickTopFindings([row])[0]).toBe(row);
  });
});

describe("presentation helpers", () => {
  const theme = {
    ...c("f1", "GHOST_SCRIPT", "HIGH"),
    filename: "layout/theme.liquid",
    lineNumber: 42,
  };

  it("cost line is the primary lane's so-what copy", () => {
    expect(findingCostLine("GHOST_SCRIPT")).toBe(
      "This is loading extra code that slows your storefront down.",
    );
    expect(findingCostLine("ORPHAN_ASSET")).toBe(
      "Leftover clutter with no live impact. Clean up when convenient.",
    );
  });

  it("malicious findings get their own cost line", () => {
    expect(findingCostLine("MALICIOUS_SCRIPT")).toBe(
      "This code can steal shopper data or send your customers to other sites.",
    );
  });

  it("no merchant copy uses an em or en dash", () => {
    for (const t of ["GHOST_SCRIPT", "MALICIOUS_SCRIPT", "GHOST_PAGE"] as FindingType[]) {
      expect(findingCostLine(t)).not.toMatch(/[–—]/);
    }
  });

  it("location: theme file with line, without a 0 line, admin resource, storefront", () => {
    expect(findingLocation(theme)).toBe("layout/theme.liquid, line 42");
    expect(findingLocation({ ...theme, lineNumber: 0 })).toBe("layout/theme.liquid");
    const page = findingLocation({
      ...c("p", "GHOST_PAGE", "LOW"),
      filename: "pages/old-reviews",
      lineNumber: 0,
    });
    expect(page).toBe("Page: /pages/old-reviews");
    expect(
      findingLocation({
        ...c("t", "GHOST_TAG", "LOW"),
        filename: "products/gid://shopify/Product/1/tags/x",
        lineNumber: 0,
      }),
    ).toBe("Product");
    expect(
      findingLocation({ ...c("t", "SCRIPT_TAG_SUNSET", "MEDIUM"), filename: "x", lineNumber: 0 }),
    ).toBe("Your storefront's script tags");
  });

  it("href: full list filters to the type; Free and malicious anchor on the unfiltered page", () => {
    expect(topFindingHref("scan-1", { id: "f1", findingType: "GHOST_SCRIPT" }, true)).toBe(
      "/app/scans/scan-1?type=GHOST_SCRIPT#finding-f1",
    );
    expect(topFindingHref("scan-1", { id: "f1", findingType: "GHOST_SCRIPT" }, false)).toBe(
      "/app/scans/scan-1#finding-f1",
    );
    expect(topFindingHref("scan-1", { id: "m", findingType: "MALICIOUS_SCRIPT" }, true)).toBe(
      "/app/scans/scan-1#finding-m",
    );
    expect(findingAnchorId("f1")).toBe("finding-f1");
  });

  it("toTopFindingViews carries only display fields (no snippet)", () => {
    const [view] = toTopFindingViews(
      "scan-1",
      [{ ...theme, codeSnippet: "secret" } as never],
      false,
    );
    expect(view).toEqual({
      id: "f1",
      severity: "HIGH",
      typeLabel: "Scripts",
      location: "layout/theme.liquid, line 42",
      cost: "This is loading extra code that slows your storefront down.",
      href: "/app/scans/scan-1#finding-f1",
    });
  });
});
