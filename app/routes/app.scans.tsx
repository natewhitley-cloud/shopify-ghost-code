import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { getScansForShop } from "../models/scan.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScanStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(
  status: ScanStatus,
): "info" | "caution" | "success" | "critical" {
  switch (status) {
    case "PENDING":
      return "info";
    case "IN_PROGRESS":
      return "caution";
    case "COMPLETED":
      return "success";
    case "FAILED":
      return "critical";
  }
}

function statusLabel(status: ScanStatus): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "IN_PROGRESS":
      return "In Progress";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopByDomain(session.shop);

  if (!shop) {
    return { scans: [] };
  }

  const scans = await getScansForShop(shop.id, { limit: 20 });

  return { scans };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScanHistory() {
  const { scans } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Scan History">
      <s-link slot="primary-action" href="/app">
        Back to Dashboard
      </s-link>

      {scans.length === 0 ? (
        <s-empty-state heading="No scans yet">
          <s-paragraph>Run your first scan from the dashboard.</s-paragraph>
        </s-empty-state>
      ) : (
        <s-card>
          <s-data-table>
            <table>
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
                    <td>{formatDate(scan.createdAt)}</td>
                    <td>{scan.themeName}</td>
                    <td>
                      <s-badge tone={statusTone(scan.status as ScanStatus)}>
                        {statusLabel(scan.status as ScanStatus)}
                      </s-badge>
                    </td>
                    <td>{scan.findingCount}</td>
                    <td>
                      <s-link href={`/app/scans/${scan.id}`}>View</s-link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-data-table>
        </s-card>
      )}
    </s-page>
  );
}
