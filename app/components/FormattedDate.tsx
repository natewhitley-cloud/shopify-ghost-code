import { formatDate } from "../lib/format";
import { useHydrated } from "../lib/use-hydrated";

// Renders a date safe for SSR hydration. Pre-hydration (server + first client
// render) it formats deterministically in UTC so the markup matches. After
// mount it re-renders in the merchant's LOCAL timezone, adding the time when
// includeTime is set. suppressHydrationWarning is belt-and-suspenders per
// React's documented guidance for timestamps.
export function FormattedDate({
  value,
  includeTime = false,
}: {
  value: Date | string | null | undefined;
  includeTime?: boolean;
}) {
  const hydrated = useHydrated();
  if (!value) return <>{formatDate(value)}</>; // "—"
  const iso = (typeof value === "string" ? new Date(value) : value).toISOString();
  const text = hydrated ? formatDate(value, includeTime) : formatDate(value, false, "UTC");
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
