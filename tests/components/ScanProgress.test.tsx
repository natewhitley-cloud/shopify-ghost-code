/**
 * Tests for app/components/ScanProgress.tsx
 *
 * GC has no jsdom/@testing-library, so (as in FormattedDate.test.tsx) the
 * component is rendered with react-dom/server. That never runs effects, which
 * is exactly the SSR / first-client-render state: the clock has not started,
 * so the first phrase shows and the elapsed line is absent (hydration-stable).
 * The post-mount rotation is pure scanProgressPhrase(elapsed), covered in
 * tests/lib/scan-progress.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";

import { ScanProgress } from "../../app/components/ScanProgress";
import { SCAN_DURATION_EXPECTATION, SCAN_PHRASES } from "../../app/lib/scan-progress";

function render(props: Parameters<typeof ScanProgress>[0]): string {
  return renderToStaticMarkup(createElement(ScanProgress, props));
}

/** Escape text the way renderToStaticMarkup does for the characters we use. */
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");

describe("ScanProgress", () => {
  const createdAt = "2026-10-08T10:00:00.000Z";

  it("announces one stable polite status", () => {
    const out = render({ createdAt });
    expect(out.match(/role="status"/g)).toHaveLength(1);
    expect(out).toMatch(/<span role="status"[^>]*>Scan in progress<\/span>/);
  });

  it("renders the first phrase, hidden from screen readers, before the clock starts", () => {
    const out = render({ createdAt });
    expect(out).toMatch(new RegExp(`<div aria-hidden="true"[^>]*>${html(SCAN_PHRASES[0])}</div>`));
  });

  it("shows the duration expectation and no elapsed line before mount", () => {
    const out = render({ createdAt });
    expect(out).toContain(SCAN_DURATION_EXPECTATION);
    expect(out).not.toContain("Started ");
  });

  it("shows the findings-so-far line only when the count is above 0", () => {
    expect(render({ createdAt, findingCount: 3 })).toContain("Found 3 findings so far…");
    expect(render({ createdAt, findingCount: 0 })).not.toContain("so far");
    expect(render({ createdAt })).not.toContain("so far");
  });

  it("never tells the merchant to leave or come back", () => {
    const out = render({ createdAt, findingCount: 2 });
    expect(out).not.toMatch(/\b(come back|leave|later|e-?mail)\b/i);
    expect(out).not.toMatch(/[—–]/);
  });
});

describe("ScanProgress: nothing that changes over time is announced", () => {
  it("aria-hides both the rotating phrase and the per-second elapsed line", () => {
    const out = render({ createdAt: "2026-10-08T10:00:00.000Z" });
    // Exactly two hidden blocks: the phrase, then the (pre-mount empty) elapsed slot.
    expect(out.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(out).toMatch(/<div aria-hidden="true"[^>]*><\/div><\/div>$/);
    // No live region besides the single status.
    expect(out).not.toContain("aria-live");
  });
});
