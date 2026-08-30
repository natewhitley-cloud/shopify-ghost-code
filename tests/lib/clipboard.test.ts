/**
 * Tests for app/lib/clipboard.ts
 *
 * The embedded app runs inside an iframe where navigator.clipboard.writeText
 * can be blocked. These tests verify:
 *   - the async Clipboard API is used when available and succeeds
 *   - a rejected Clipboard API falls back to execCommand("copy")
 *   - the execCommand path is used when navigator.clipboard is absent
 *   - failures return false rather than throwing
 *
 * The test environment is Node with no DOM, so navigator/document are stubbed
 * on globalThis per test and restored afterward.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { copyToClipboard } from "../../app/lib/clipboard";

// ---------------------------------------------------------------------------
// Global stubbing helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a minimal fake document whose execCommand result is configurable. */
function stubDocument(execResult: boolean, spies?: { append?: () => void; remove?: () => void }) {
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
  };
  const doc = {
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => execResult),
    body: {
      appendChild: vi.fn(spies?.append),
      removeChild: vi.fn(spies?.remove),
    },
  };
  vi.stubGlobal("document", doc);
  return { doc, textarea };
}

// ---------------------------------------------------------------------------
// Async Clipboard API path
// ---------------------------------------------------------------------------

describe("copyToClipboard — async Clipboard API", () => {
  it("uses navigator.clipboard.writeText and returns true on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    // Ensure the fallback is not needed.
    vi.stubGlobal("document", undefined);

    const result = await copyToClipboard("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result).toBe(true);
  });

  it("falls back to execCommand when writeText rejects (iframe blocked)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked by permissions policy"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { doc } = stubDocument(true);

    const result = await copyToClipboard("payload");

    expect(writeText).toHaveBeenCalledWith("payload");
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// execCommand fallback path
// ---------------------------------------------------------------------------

describe("copyToClipboard — execCommand fallback", () => {
  it("uses the textarea + execCommand path when navigator.clipboard is absent", async () => {
    vi.stubGlobal("navigator", {});
    const { doc, textarea } = stubDocument(true);

    const result = await copyToClipboard("copied text");

    expect(doc.createElement).toHaveBeenCalledWith("textarea");
    expect(textarea.value).toBe("copied text");
    expect(textarea.select).toHaveBeenCalled();
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(doc.body.appendChild).toHaveBeenCalled();
    expect(doc.body.removeChild).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("returns false when execCommand reports failure", async () => {
    vi.stubGlobal("navigator", {});
    stubDocument(false);

    const result = await copyToClipboard("nope");

    expect(result).toBe(false);
  });

  it("returns false when neither navigator.clipboard nor document is available", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);

    const result = await copyToClipboard("no host");

    expect(result).toBe(false);
  });
});
