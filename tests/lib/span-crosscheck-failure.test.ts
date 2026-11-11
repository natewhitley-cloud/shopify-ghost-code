/**
 * gc-t44r X2 (r5): a parse5 throw never escapes the cross-check. The file is
 * refused as a whole, the result is cached (one parse per file), and one log
 * line is written with no file content in it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ throwOnParse: false, parses: 0, warn: vi.fn() }));

vi.mock("parse5", async (orig) => {
  const real = (await orig()) as typeof import("parse5");
  return {
    ...real,
    parse: (...args: Parameters<typeof real.parse>) => {
      holder.parses++;
      if (holder.throwOnParse) throw new Error("parse5 boom SECRET_BODY_TEXT");
      return real.parse(...args);
    },
  };
});
vi.mock("../../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: holder.warn, error: vi.fn() },
}));

import { createSpanCrossCheck } from "../../app/lib/span-crosscheck.server";

const CONTENT = "<p>SECRET_BODY_TEXT</p>\n<link rel=stylesheet href=a>";
const LINK = { start: CONTENT.indexOf("<link"), end: CONTENT.length };

afterEach(() => {
  holder.throwOnParse = false;
  holder.parses = 0;
  holder.warn.mockClear();
});

describe("parse5 failure handling", () => {
  it("a throw refuses every span in the file, parses once and logs once without content", () => {
    holder.throwOnParse = true;
    const cc = createSpanCrossCheck(CONTENT);
    for (let i = 0; i < 3; i++) {
      expect(cc("GHOST_STYLE", LINK)).toEqual({ ok: false, reason: "PARSER_DISAGREES" });
    }
    expect(holder.parses).toBe(1);
    expect(holder.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(holder.warn.mock.calls)).not.toContain("SECRET_BODY_TEXT");
  });

  it("without a throw the same span confirms (control)", () => {
    expect(createSpanCrossCheck(CONTENT)("GHOST_STYLE", LINK)).toMatchObject({ ok: true });
    expect(holder.warn).not.toHaveBeenCalled();
  });
});
