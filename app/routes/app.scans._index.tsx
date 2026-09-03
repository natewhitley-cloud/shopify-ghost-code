import type { CSSProperties } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { FormattedDate } from "../components/FormattedDate";
import { readValue } from "../components/polaris-events";
import { statusTone, statusLabel } from "../lib/format";
import type { ScanStatus } from "../lib/format";
import { useFilterSearchParams } from "../lib/use-filter-search-params";
import { getScansForShop, getDistinctThemesForShop } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import { authenticate } from "../shopify.server";
import {
  BORDER_DEFAULT,
  BG_HOVER,
  BG_SURFACE,
  BG_SURFACE_ALT,
  COLOR_INFO,
  groundStyle,
  hairline,
  styles,
} from "../styles/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

/**
 * Every valid ScanStatus value. Used to (1) validate the `?status=` param in the
 * loader — an unknown value is ignored rather than passed to the DB — and (2)
 * build the Status filter dropdown. Order = dropdown display order.
 */
const SCAN_STATUS_VALUES: ScanStatus[] = [
  "COMPLETED",
  "PARTIAL",
  "IN_PROGRESS",
  "PENDING",
  "FAILED",
];

const filterLabelStyle: CSSProperties = {
  marginBottom: "4px",
  fontSize: "13px",
  fontWeight: 600,
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);

  if (!shop) {
    return { scans: [], nextCursor: null, themes: [], theme: "", status: "" };
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || undefined;

  // Theme is a free-form match against Scan.themeName; empty string = no filter.
  const theme = url.searchParams.get("theme") || undefined;

  // Validate status against the known ScanStatus set — an unknown/garbage value
  // is treated as "no status filter" rather than passed through to the query.
  const rawStatus = url.searchParams.get("status") || undefined;
  const status =
    rawStatus && SCAN_STATUS_VALUES.includes(rawStatus as ScanStatus)
      ? (rawStatus as ScanStatus)
      : undefined;

  const [{ items: scans, hasNextPage }, themes] = await Promise.all([
    getScansForShop(shop.id, { limit: PAGE_SIZE, cursor, theme, status }),
    getDistinctThemesForShop(shop.id),
  ]);

  const nextCursor = hasNextPage ? scans[scans.length - 1].id : null;

  return { scans, nextCursor, themes, theme: theme ?? "", status: status ?? "" };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScanHistory() {
  const { scans, nextCursor, themes, theme, status } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useFilterSearchParams();

  // A non-empty theme list means the shop has scanned at least once — the list
  // is derived from ALL scans, not the filtered page. This distinguishes "no
  // scans yet" from "no scans match the active filters".
  const hasAnyScans = themes.length > 0;
  const hasActiveFilter = theme !== "" || status !== "";

  // Set (or clear) a single filter param and reset pagination. Clearing the
  // cursor is essential: a stale `?cursor=` from a previous page must not
  // combine with a freshly changed filter (it would page into a now-different
  // result set). preventScrollReset is handled by useFilterSearchParams.
  function updateFilter(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
      next.delete("cursor");
      return next;
    });
  }

  function clearFilters() {
    setSearchParams(() => new URLSearchParams());
  }

  // Preserve active filters across the cursor "Load More" navigation — a bare
  // `?cursor=` link would drop the theme/status filters and page into the
  // unfiltered result set.
  const loadMoreParams = new URLSearchParams();
  if (theme) loadMoreParams.set("theme", theme);
  if (status) loadMoreParams.set("status", status);
  if (nextCursor) loadMoreParams.set("cursor", nextCursor);

  return (
    <s-page heading="Scan History">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>
      <div style={hairline} />
      <div style={groundStyle}>
        <style>{`
        .scan-history-table {
          width: 100%;
          border-collapse: collapse;
        }
        .scan-history-table th,
        .scan-history-table td {
          border: 1px solid ${BORDER_DEFAULT};
          padding: 12px 16px;
          text-align: left;
        }
        .scan-history-table thead th {
          background: ${BG_SURFACE};
          font-weight: 600;
        }
        .scan-history-table tbody tr:nth-child(even) {
          background: ${BG_SURFACE_ALT};
        }
        .scan-history-table tbody tr:hover {
          background: ${BG_HOVER};
        }
      `}</style>

        {!hasAnyScans ? (
          <s-empty-state heading="No scans yet">
            <s-paragraph>Run your first scan from the dashboard.</s-paragraph>
          </s-empty-state>
        ) : (
          <>
            <div style={styles.filterBar}>
              <div style={{ minWidth: "200px" }}>
                <div style={filterLabelStyle}>Theme</div>
                <s-select
                  aria-label="Theme"
                  value={theme}
                  onChange={(e: unknown) => updateFilter("theme", readValue(e))}
                >
                  <s-option value="">All themes</s-option>
                  {themes.map((name) => (
                    <s-option key={name} value={name}>
                      {name}
                    </s-option>
                  ))}
                </s-select>
              </div>
              <div style={{ minWidth: "200px" }}>
                <div style={filterLabelStyle}>Status</div>
                <s-select
                  aria-label="Status"
                  value={status}
                  onChange={(e: unknown) => updateFilter("status", readValue(e))}
                >
                  <s-option value="">All statuses</s-option>
                  {SCAN_STATUS_VALUES.map((value) => (
                    <s-option key={value} value={value}>
                      {statusLabel(value)}
                    </s-option>
                  ))}
                </s-select>
              </div>
              {hasActiveFilter && (
                <button
                  type="button"
                  onClick={clearFilters}
                  style={{
                    border: 0,
                    background: "transparent",
                    color: COLOR_INFO,
                    font: "inherit",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>

            {scans.length === 0 ? (
              <s-empty-state heading="No scans match these filters">
                <s-paragraph>Try a different theme or status, or clear the filters.</s-paragraph>
              </s-empty-state>
            ) : (
              <>
                <s-card>
                  <table className="scan-history-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Theme</th>
                        <th>Status</th>
                        <th>Findings</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scans.map((scan) => (
                        <tr key={scan.id}>
                          <td>
                            <FormattedDate value={scan.createdAt} includeTime />
                          </td>
                          <td>{scan.themeName}</td>
                          <td>
                            <s-badge tone={statusTone(scan.status as ScanStatus)}>
                              {statusLabel(scan.status as ScanStatus)}
                            </s-badge>
                          </td>
                          <td>{scan.findingCount}</td>
                          <td>
                            <Link
                              to={`/app/scans/${scan.id}`}
                              style={{ color: COLOR_INFO, textDecoration: "none" }}
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </s-card>

                {nextCursor && (
                  <s-box padding-block-start="base">
                    <s-stack direction="inline" gap="base">
                      <Link to={`/app/scans?${loadMoreParams.toString()}`} preventScrollReset>
                        Load More
                      </Link>
                    </s-stack>
                  </s-box>
                )}
              </>
            )}
          </>
        )}
      </div>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
