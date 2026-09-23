// Ported from ClearSignal (bot-analytics-cleanup-app).
/**
 * Read values from Polaris Web Component (`s-*`) change/input events.
 *
 * Polaris WC form controls (`s-select`, `s-text-field`, `s-checkbox`, …)
 * dispatch a standard DOM change/input event whose value lives ON THE
 * ELEMENT (`event.currentTarget.value` / `.checked`) — NOT in
 * `event.detail`. Per the docs the `change` event is a `CallbackEvent`
 * (`Event & { currentTarget }`), and `s-select.value` is "the value
 * attribute of the currently selected option".
 *
 * Verified against the Shopify App Home Polaris docs (unversioned / 2026-07):
 *   shopify.dev/docs/api/app-home/web-components/forms/select
 *   shopify.dev/docs/api/app-home/web-components/forms/checkbox
 * The native `<input>` IP filter (app.sessions.tsx) and the shop-domain
 * field (auth.login) already read `currentTarget.value` and work.
 *
 * Reading `event.detail` returns `undefined` for these events — the root
 * cause of ba-76c, where the Sessions Classification filter silently never
 * set its `?classification=` param.
 */

// The element that dispatched the event. Prefer `currentTarget` (the element
// the handler is bound to — strongly typed by Polaris' CallbackEvent); fall
// back to `target` defensively.
function eventElement(e: unknown): (HTMLInputElement & HTMLSelectElement) | null {
  if (typeof e !== "object" || e === null) return null;
  const evt = e as { currentTarget?: unknown; target?: unknown };
  const el = evt.currentTarget ?? evt.target;
  return typeof el === "object" && el !== null
    ? (el as HTMLInputElement & HTMLSelectElement)
    : null;
}

/** String value of an `s-select` / `s-text-field` change event. */
export function readValue(e: unknown): string {
  const el = eventElement(e);
  return typeof el?.value === "string" ? el.value : "";
}
