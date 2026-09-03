/**
 * Tests for app/components/FormattedDate.tsx
 *
 * The test environment is Node (no jsdom/@testing-library), so we render the
 * component with react-dom/server (renderToStaticMarkup) and inspect the HTML.
 * Because react-dom/server never runs effects, useHydrated reports false, which
 * is exactly the SSR / first-client-render state the component must render
 * deterministically (UTC, date-only) to keep hydration stable.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";

import { FormattedDate } from "../../app/components/FormattedDate";

function render(props: Parameters<typeof FormattedDate>[0]): string {
  return renderToStaticMarkup(createElement(FormattedDate, props));
}

describe("FormattedDate", () => {
  it("renders the deterministic UTC date-only text on the pre-hydration render", () => {
    // 23:30 UTC would render as the NEXT day in UTC+ local zones if formatted
    // locally; the UTC pre-hydration render must show Mar 10 regardless.
    const html = render({ value: "2025-03-10T23:30:00.000Z" });
    expect(html).toContain("Mar 10, 2025");
  });

  it("omits the time on the pre-hydration render even when includeTime is set", () => {
    // Pre-hydration always renders date-only (deterministic); time is added
    // client-side after mount. So no AM/PM should appear in the SSR markup.
    const html = render({ value: "2025-03-10T23:30:00.000Z", includeTime: true });
    expect(html).toContain("Mar 10, 2025");
    expect(html).not.toMatch(/AM|PM/i);
  });

  it("wraps the date in a <time> element with a valid ISO dateTime attribute", () => {
    const html = render({ value: "2025-03-10T23:30:00.000Z" });
    expect(html).toMatch(/<time[^>]*datetime="2025-03-10T23:30:00\.000Z"/i);
    expect(html).toContain("</time>");
  });

  it("accepts a Date object and emits its ISO string as the dateTime attribute", () => {
    const html = render({ value: new Date("2025-03-10T23:30:00.000Z") });
    expect(html).toMatch(/datetime="2025-03-10T23:30:00\.000Z"/i);
    expect(html).toContain("Mar 10, 2025");
  });

  it("renders the em-dash placeholder for null without a <time> wrapper", () => {
    const html = render({ value: null });
    expect(html).toContain("—");
    expect(html).not.toContain("<time");
  });

  it("renders the em-dash placeholder for undefined", () => {
    const html = render({ value: undefined });
    expect(html).toContain("—");
    expect(html).not.toContain("<time");
  });
});
