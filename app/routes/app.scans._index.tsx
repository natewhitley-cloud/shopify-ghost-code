import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { formatDate, statusTone, statusLabel } from "../lib/format";
import type { ScanStatus } from "../lib/format";
import { getScansForShop } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import { authenticate } from "../shopify.server";
import { BORDER_DEFAULT, BG_HOVER, BG_SURFACE, BG_SURFACE_ALT, COLOR_INFO } from "../styles/shared";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);

  if (!shop) {
    return { scans: [], nextCursor: null };
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || undefined;

  const { items: scans, hasNextPage } = await getScansForShop(shop.id, {
    limit: PAGE_SIZE,
    cursor,
  });

  const nextCursor = hasNextPage ? scans[scans.length - 1].id : null;

  return { scans, nextCursor };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScanHistory() {
  const { scans, nextCursor } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Scan History">
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
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>

      {scans.length === 0 ? (
        <s-empty-state heading="No scans yet">
          <s-paragraph>Run your first scan from the dashboard.</s-paragraph>
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
                    <td>{formatDate(scan.createdAt, true)}</td>
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
                <Link to={`/app/scans?cursor=${nextCursor}`}>Load More</Link>
              </s-stack>
            </s-box>
          )}
        </>
      )}
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
