/**
 * Clipboard helper for the embedded (iframe) Shopify app.
 *
 * This app runs inside the Shopify Admin iframe, where
 * `navigator.clipboard.writeText` can be blocked by the frame's permissions
 * policy and reject at call time. We therefore try the async Clipboard API
 * first and fall back to a hidden textarea + `document.execCommand("copy")`,
 * which works in sandboxed iframes and older browsers.
 *
 * Pure, client-safe module (no .server suffix). Returns true when either path
 * succeeds so callers can show a confirmation or an error.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Preferred path: async Clipboard API. May reject inside a sandboxed iframe.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Blocked or unavailable — fall through to the execCommand fallback.
    }
  }

  // Fallback: hidden textarea + execCommand("copy").
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Keep it out of view and prevent scroll/zoom jumps when it receives focus.
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.setAttribute("readonly", "");
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
