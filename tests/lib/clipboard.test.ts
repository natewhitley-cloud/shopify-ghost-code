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
    // The fallback removes the node via textarea.remove() (guaranteed on both
    // the success and throw paths by a finally block), not body.removeChild.
    remove: vi.fn(spies?.remove),
  };
  const doc = {
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => execResult),
    body: {
      appendChild: vi.fn(spies?.append),
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
    expect(textarea.remove).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("returns false when execCommand reports failure", async () => {
    vi.stubGlobal("navigator", {});
    const { textarea } = stubDocument(false);

    const result = await copyToClipboard("nope");

    expect(result).toBe(false);
    // Even on a failed copy the textarea must be cleaned up (no orphan leak).
    expect(textarea.remove).toHaveBeenCalled();
  });

  it("removes the textarea on the throw path (no orphaned node leak)", async () => {
    vi.stubGlobal("navigator", {});
    const { doc, textarea } = stubDocument(true);
    // Simulate select()/execCommand throwing inside a sandboxed iframe.
    doc.execCommand.mockImplementation(() => {
      throw new Error("execCommand not permitted");
    });

    const result = await copyToClipboard("throws");

    // Return value semantics unchanged: a thrown fallback still returns false.
    expect(result).toBe(false);
    // The finally block guarantees cleanup even though execCommand threw.
    expect(textarea.remove).toHaveBeenCalled();
  });

  it("returns false when neither navigator.clipboard nor document is available", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);

    const result = await copyToClipboard("no host");

    expect(result).toBe(false);
  });
});
