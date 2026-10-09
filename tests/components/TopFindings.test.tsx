/**
 * Tests for app/components/TopFindings.tsx (gc-bn0x): the shared "Start here"
 * block. Rendered with react-dom/server inside a MemoryRouter (the links are
 * react-router Links).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, it, expect } from "vitest";

import { TopFindings, topFindingsIntro } from "../../app/components/TopFindings";
import type { TopFindingView } from "../../app/lib/top-findings";

function view(n: number): TopFindingView {
  return {
    id: `f${n}`,
    severity: n === 1 ? "HIGH" : "LOW",
    typeLabel: `Type ${n}`,
    location: `snippets/file-${n}.liquid, line ${n}`,
    cost: `Cost line ${n}.`,
    href: `/app/scans/scan-1#finding-f${n}`,
  };
}

function render(findings: TopFindingView[]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(TopFindings, { findings })),
  );
}

describe("TopFindings", () => {
  it("renders nothing for 0 findings (the clean-scan state stays as is)", () => {
    expect(render([])).toBe("");
  });

  it.each([1, 2, 3])("renders exactly %i findings as an ordered list", (n) => {
    const html = render(Array.from({ length: n }, (_, i) => view(i + 1)));
    expect(html.match(/<li[ >]/g)).toHaveLength(n);
    expect(html).toContain("<ol");
    expect(html).toContain(topFindingsIntro(n));
  });

  it("each finding shows its type, severity, location, cost, and link to its row", () => {
    const html = render([view(1)]);
    expect(html).toContain("<h3");
    expect(html).toContain("Type 1");
    expect(html).toMatch(/<s-badge tone="critical">HIGH<\/s-badge>/);
    expect(html).toContain("snippets/file-1.liquid, line 1");
    expect(html).toContain("Cost line 1.");
    expect(html).toContain('href="/app/scans/scan-1#finding-f1"');
    expect(html).toContain("See how to fix");
  });

  it("is a labelled region with a heading, and never a live region", () => {
    const html = render([view(1), view(2)]);
    expect(html).toContain('aria-labelledby="top-findings-heading"');
    expect(html).toMatch(/<h2 id="top-findings-heading"[^>]*>Start here<\/h2>/);
    expect(html).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  it("intro copy reads naturally for 1 and for several, with no dashes", () => {
    expect(topFindingsIntro(1)).toBe(
      "The finding that matters most in this scan, and what it costs you.",
    );
    expect(topFindingsIntro(3)).toBe(
      "The 3 findings that matter most in this scan, and what each costs you.",
    );
    expect(topFindingsIntro(3)).not.toMatch(/[–—]/);
  });
});
