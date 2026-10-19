/**
 * Settings Permissions card states (gc-4wvb): the App Bridge hook is mocked so
 * each state (all granted, some missing, failed, unsupported, checking) renders
 * through the real PermissionsCard.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/lib/use-optional-scopes", () => ({ useOptionalScopes: vi.fn() }));

import { missingOptionalScopes, OPTIONAL_SCOPES } from "../../app/lib/optional-scopes";
import type { OptionalScopesState } from "../../app/lib/use-optional-scopes";
import { useOptionalScopes } from "../../app/lib/use-optional-scopes";
import { PermissionsCard } from "../../app/routes/app.settings";
import { TABLE_BG_STRIPE } from "../../app/styles/shared";

const mockHook = useOptionalScopes as unknown as ReturnType<typeof vi.fn>;

function state(over: Partial<OptionalScopesState>): OptionalScopesState {
  const granted = over.granted === undefined ? null : over.granted;
  return {
    granted,
    unsupported: false,
    failed: false,
    requesting: false,
    missing: missingOptionalScopes(granted ?? []),
    requestMissing: vi.fn(),
    ...over,
  } as OptionalScopesState;
}

function render(s: OptionalScopesState, brokenLinksIncluded = true): string {
  mockHook.mockReturnValue(s);
  return renderToStaticMarkup(createElement(PermissionsCard, { brokenLinksIncluded }));
}

const badges = (html: string) =>
  [...html.matchAll(/<s-badge tone="([^"]+)">([^<]*)<\/s-badge>/g)].map((m) => `${m[1]}:${m[2]}`);

beforeEach(() => mockHook.mockReset());

describe("PermissionsCard", () => {
  it("is an h2 section header over a section card (no s-card / s-heading)", () => {
    const html = render(state({ granted: [...OPTIONAL_SCOPES] }));
    expect(html).toMatch(/^<section><h2 style="[^"]*">Permissions<\/h2><div style="/);
    expect(html).not.toContain("<s-card");
    expect(html).not.toContain("<s-heading");
  });

  it("all granted: a two-column table, every row Granted, one green line, no button", () => {
    const html = render(state({ granted: [...OPTIONAL_SCOPES] }));
    expect(html).toMatch(/<th scope="col"[^>]*>Permission and what it checks<\/th>/);
    expect(html).toMatch(
      /<th scope="col" style="text-align:right;[^"]*width:120px;white-space:nowrap">Status<\/th>/,
    );
    expect(html.match(/<tr>/g)).toHaveLength(OPTIONAL_SCOPES.length + 1);
    expect(badges(html)).toEqual(OPTIONAL_SCOPES.map(() => "success:Granted"));
    expect(html).toContain(
      '<span aria-hidden="true">✓</span> All granted. These checks run on every scan.',
    );
    expect(html).not.toContain("<s-banner");
    expect(html).not.toContain("<s-button");
    expect(html).not.toContain("not granted.");
  });

  it("zebra rows: every second row carries the stripe background", () => {
    const html = render(state({ granted: [...OPTIONAL_SCOPES] }));
    const rows = html.split("<tr>").slice(2); // skip before-thead and the header row
    rows.forEach((row, i) => {
      if (i % 2 === 1) expect(row).toContain(`background-color:${TABLE_BG_STRIPE}`);
      else expect(row).not.toContain(`background-color:${TABLE_BG_STRIPE}`);
    });
  });

  it("two missing: their badges say Not granted and the line counts against the total", () => {
    const granted = OPTIONAL_SCOPES.filter(
      (s) => s !== "read_translations" && s !== "read_locales",
    );
    const html = render(state({ granted: [...granted] }));
    expect(badges(html).filter((b) => b === "warning:Not granted")).toHaveLength(2);
    expect(html).toContain(
      `2 of ${OPTIONAL_SCOPES.length} not granted. Those checks are skipped on your scans.`,
    );
    expect(html).toContain('<s-button variant="primary">Grant access</s-button>');
    expect(html).not.toContain("All granted");
  });

  it("none granted: n equals the total", () => {
    const html = render(state({ granted: [] }));
    expect(html).toContain(`${OPTIONAL_SCOPES.length} of ${OPTIONAL_SCOPES.length} not granted.`);
  });

  it("requesting: the button is disabled and reads Requesting…", () => {
    const html = render(state({ granted: [], requesting: true }));
    expect(html).toMatch(/<s-button variant="primary" disabled="true">Requesting…<\/s-button>/);
  });

  it("query failed: neutral Status unavailable badges, no count, the button and the error", () => {
    const html = render(state({ granted: null, failed: true }));
    expect(badges(html)).toEqual(OPTIONAL_SCOPES.map(() => "neutral:Status unavailable"));
    expect(html).not.toContain("not granted.");
    expect(html).toContain(">Grant access</s-button>");
    expect(html).toContain(
      '<s-banner tone="critical">Something went wrong updating permissions. Please try again.</s-banner>',
    );
  });

  it("unsupported: the reload note, no table or button", () => {
    const html = render(state({ unsupported: true }));
    expect(html).toContain("Permission status is unavailable in this view.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<s-button");
  });

  it("checking (first render): the checking line, no table", () => {
    const html = render(state({ granted: null }));
    expect(html).toContain("Checking permissions…");
    expect(html).not.toContain("<table");
  });

  it("Free (no broken links): the plan note and the content line without broken links", () => {
    const html = render(state({ granted: [...OPTIONAL_SCOPES] }), false);
    expect(html).toContain("Broken-link checks come with the Standard plan.");
    expect(html).toContain("Finds orphaned content pages left behind by uninstalled apps.");
  });
});
