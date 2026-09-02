// Ported from ClearSignal (bot-analytics-cleanup-app).
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import type { SetURLSearchParams } from "react-router";

/**
 * Filter-aware wrapper around `useSearchParams`.
 *
 * React Router resets scroll to the top of the page on every
 * `setSearchParams(...)` navigation UNLESS `{ preventScrollReset: true }` is
 * passed. Filter controls (period selectors, class/IP filters, pagination)
 * mutate the URL in place and must NOT jump the page to the top.
 *
 * This hook is the single sanctioned path for filter navigations: the returned
 * setter ALWAYS merges `preventScrollReset: true` into the navigate options, so
 * no call site has to remember it (and none can forget it). Any caller-supplied
 * options are preserved; `preventScrollReset` wins so scroll is never reset.
 *
 * The returned tuple mirrors `useSearchParams` exactly, so callers can read
 * `searchParams` and/or use the setter, in both the value and functional-updater
 * forms.
 *
 * NOTE: for real page changes (a different route), use `useNavigate` / `Link`,
 * which SHOULD reset scroll. This hook is for in-page filter state only.
 */
export function useFilterSearchParams(): readonly [URLSearchParams, SetURLSearchParams] {
  const [searchParams, setSearchParams] = useSearchParams();

  const setFilterSearchParams = useCallback<SetURLSearchParams>(
    (nextInit, navigateOpts) => {
      setSearchParams(nextInit, { ...navigateOpts, preventScrollReset: true });
    },
    [setSearchParams],
  );

  return [searchParams, setFilterSearchParams] as const;
}
