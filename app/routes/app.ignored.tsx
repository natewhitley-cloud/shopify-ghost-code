import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";

import { FormattedDate } from "../components/FormattedDate";
import { RunFirstScanCta } from "../components/RunFirstScanCta";
import { deleteIgnoredFindingForShop, listIgnoredFindings } from "../models/ignored-finding.server";
import { hasAnyScans } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import { authenticate } from "../shopify.server";
import {
  BG_HOVER,
  BG_SURFACE,
  BG_SURFACE_ALT,
  BORDER_DEFAULT,
  BORDER_STRONG,
  COLOR_CRITICAL,
  groundStyle,
  hairline,
  TEXT_SUBDUED,
} from "../styles/shared";

// ---------------------------------------------------------------------------
// Loader — list every suppression the shop has created (E2.3 management view).
// Not plan-gated: E2 is a trust/accuracy feature available to all plans.
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopMetadata(session.shop);

  if (!shop) {
    return { ignores: [], hasAnyScans: false };
  }

  const rows = await listIgnoredFindings(shop.id);

  // gc-vg4: the "Run your first scan" CTA shows only when the shop has never
  // scanned. Suppressions come from scan findings, so any ignore implies a scan
  // and the extra query only runs on the empty list.
  const shopHasAnyScans = rows.length > 0 ? true : await hasAnyScans(shop.id);

  // Send only the fields the view needs. Serialize createdAt to ISO so it
  // survives the loader boundary (FormattedDate accepts a string).
  const ignores = rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    fingerprint: row.fingerprint,
    appName: row.appName,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));

  return { ignores, hasAnyScans: shopHasAnyScans };
};

// ---------------------------------------------------------------------------
// Action — un-ignore (reversible). Tenant-safe: the delete is scoped to the
// shop, so a foreign id matches nothing.
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopMetadata(session.shop);
  if (!shop) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent !== "unignore") {
    return { error: "Unsupported action" };
  }

  const id = (formData.get("id") as string)?.trim();
  if (!id) return { error: "Id is required" };

  const { count } = await deleteIgnoredFindingForShop(id, shop.id);
  if (count === 0) return { error: "Suppression not found" };

  return { success: true };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type IgnoreRowData = {
  id: string;
  scope: string;
  fingerprint: string | null;
  appName: string | null;
  reason: string | null;
  createdAt: string;
};

function IgnoreRow({ row }: { row: IgnoreRowData }) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const submitting = fetcher.state !== "idle";

  const isApp = row.scope === "APP";

  return (
    <tr>
      <td>
        <s-badge tone={isApp ? "warning" : "neutral"}>{isApp ? "App rule" : "Finding"}</s-badge>
      </td>
      <td>
        {isApp ? (
          <span>
            All findings from <strong>{row.appName}</strong>
          </span>
        ) : (
          <span>
            One specific finding{" "}
            <code style={{ fontSize: "12px", color: TEXT_SUBDUED }}>#{row.fingerprint}</code>
          </span>
        )}
      </td>
      <td>{row.reason ? row.reason : <span style={{ color: TEXT_SUBDUED }}>—</span>}</td>
      <td>
        <FormattedDate value={row.createdAt} includeTime />
      </td>
      <td>
        <fetcher.Form method="post">
          <input type="hidden" name="id" value={row.id} />
          <button
            type="submit"
            name="intent"
            value="unignore"
            disabled={submitting}
            style={{
              padding: "4px 8px",
              border: `1px solid ${BORDER_STRONG}`,
              borderRadius: "4px",
              fontSize: "12px",
              background: BG_SURFACE,
              color: TEXT_SUBDUED,
              cursor: submitting ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {submitting ? "…" : "Un-ignore"}
          </button>
          {fetcher.data?.error && (
            <span style={{ color: COLOR_CRITICAL, fontSize: "12px", marginInlineStart: "8px" }}>
              {fetcher.data.error}
            </span>
          )}
        </fetcher.Form>
      </td>
    </tr>
  );
}

export default function IgnoredFindings() {
  const { ignores, hasAnyScans: shopHasAnyScans } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Ignored Findings">
      <Link to="/app/scans" slot="primary-action">
        Back to History
      </Link>
      <div style={hairline} />
      <div style={groundStyle}>
        <style>{`
        .ignored-table {
          width: 100%;
          border-collapse: collapse;
        }
        .ignored-table th,
        .ignored-table td {
          border: 1px solid ${BORDER_DEFAULT};
          padding: 12px 16px;
          text-align: left;
          vertical-align: top;
        }
        .ignored-table thead th {
          background: ${BG_SURFACE};
          font-weight: 600;
          white-space: nowrap;
        }
        .ignored-table tbody tr:nth-child(even) {
          background: ${BG_SURFACE_ALT};
        }
        .ignored-table tbody tr:hover {
          background: ${BG_HOVER};
        }
      `}</style>

        {ignores.length === 0 ? (
          <s-empty-state heading="No suppressed findings">
            <s-paragraph>
              Findings you ignore from a scan appear here. Ignored findings are excluded from your
              theme health score and finding counts, and you can restore any of them at any time.
            </s-paragraph>
            {!shopHasAnyScans && <RunFirstScanCta />}
          </s-empty-state>
        ) : (
          <s-card>
            <s-stack direction="block" gap="base">
              <s-paragraph>
                These findings are excluded from your theme health score, finding counts, and scan
                comparisons. Un-ignore any of them to bring them back.
              </s-paragraph>
              <table className="ignored-table">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Suppresses</th>
                    <th>Reason</th>
                    <th>Ignored</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ignores.map((row) => (
                    <IgnoreRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </s-stack>
          </s-card>
        )}
      </div>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
