/**
 * Admin metrics dashboard — internal operator view.
 *
 * Access is restricted to shop domains listed in ADMIN_SHOP_DOMAINS env var.
 * Non-admin shops receive a 403 response.
 *
 * URL: /app/admin/metrics
 *
 * Sections:
 *   1. Shop Metrics — total, active, by plan
 *   2. Scan Metrics — all-time, last 7d/30d, completion rate
 *   3. Finding Metrics — total, avg per scan
 *   4. Trend — 30-day history table
 *   5. Manual Check Reminders — links to Partner Dashboard pages
 *
 * "Refresh Now" action computes current metrics and upserts a snapshot.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { isAdminShop } from "../lib/admin-gate.server";
import { formatDate } from "../lib/format";
import { logger } from "../lib/logger.server";
import {
  computeCurrentMetrics,
  createMetricSnapshot,
  getLatestSnapshot,
  getSnapshotHistory,
} from "../models/metric-snapshot.server";
import type { ShopsByPlan } from "../models/metric-snapshot.server";
import { getShopMetadata } from "../models/shop.server";
import { authenticate } from "../shopify.server";
import {
  BORDER_DEFAULT,
  BG_WHITE,
  COLOR_CRITICAL,
  COLOR_INFO,
  COLOR_SUCCESS,
  CRIT_BD,
  CRIT_BG,
  INFO_BD,
  INFO_BG,
  SUCCESS_BD,
  SUCCESS_BG,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  WARN_BD,
  WARN_BG,
  WARN_TEXT,
  sectionCard,
  sectionHeader,
  styles,
} from "../styles/shared";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Admin gate — use getShopMetadata (no token decryption needed)
  const shop = await getShopMetadata(session.shop);
  if (!shop || !isAdminShop(session.shop)) {
    throw new Response("Forbidden", { status: 403 });
  }

  const [latestSnapshot, snapshotHistory] = await Promise.all([
    getLatestSnapshot(),
    getSnapshotHistory(30),
  ]);

  return {
    shopDomain: session.shop,
    latestSnapshot,
    snapshotHistory,
  };
};

// ---------------------------------------------------------------------------
// Action — "Refresh Now"
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);
  if (!shop || !isAdminShop(session.shop)) {
    throw new Response("Forbidden", { status: 403 });
  }

  logger.info("admin-metrics-refresh-requested", { shopDomain: session.shop });

  const metrics = await computeCurrentMetrics();
  await createMetricSnapshot(metrics);

  logger.info("admin-metrics-refresh-complete", {
    shopDomain: session.shop,
    snapshotDate: metrics.snapshotDate.toISOString(),
  });

  return { ok: true };
};

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

function MetricTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "info" | "success" | "warning" | "critical";
}) {
  const tintMap = {
    info: { border: INFO_BD, bg: INFO_BG, text: COLOR_INFO },
    success: { border: SUCCESS_BD, bg: SUCCESS_BG, text: COLOR_SUCCESS },
    warning: { border: WARN_BD, bg: WARN_BG, text: WARN_TEXT },
    critical: { border: CRIT_BD, bg: CRIT_BG, text: COLOR_CRITICAL },
  } as const;
  const tint = accent ? tintMap[accent] : null;
  return (
    <div
      style={{
        padding: "16px 20px",
        borderRadius: "8px",
        border: `1px solid ${tint ? tint.border : BORDER_DEFAULT}`,
        background: tint ? tint.bg : BG_WHITE,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginBottom: "4px" }}>{label}</div>
      <div
        style={{
          fontSize: "28px",
          fontWeight: 700,
          lineHeight: 1,
          color: tint ? tint.text : TEXT_PRIMARY,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 style={{ ...sectionHeader, marginTop: "24px" }}>{children}</h2>;
}

function planLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminMetrics() {
  const { latestSnapshot, snapshotHistory } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const isRefreshing = fetcher.state !== "idle";

  const snap = latestSnapshot;

  return (
    <s-page heading="Admin Metrics Dashboard">
      {/* Action bar */}
      <div style={{ marginBottom: "24px", display: "flex", gap: "12px", alignItems: "center" }}>
        <fetcher.Form method="post">
          <s-button variant="primary" disabled={isRefreshing} type="submit">
            {isRefreshing ? "Refreshing…" : "Refresh Now"}
          </s-button>
        </fetcher.Form>
        {snap && (
          <span style={{ fontSize: "13px", color: TEXT_SUBDUED }}>
            Last snapshot: {formatDate(new Date(snap.snapshotDate))}
          </span>
        )}
      </div>

      {!snap && (
        <s-banner tone="info">
          No snapshots yet. Click &quot;Refresh Now&quot; to compute the first snapshot.
        </s-banner>
      )}

      {snap && (
        <>
          {/* ----------------------------------------------------------------
              Section 1: Shop Metrics
          ---------------------------------------------------------------- */}
          <div style={sectionCard}>
            <SectionHeading>Shop Metrics</SectionHeading>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "12px",
                marginBottom: "20px",
              }}
            >
              <MetricTile label="Total Shops" value={snap.totalShops} />
              <MetricTile label="Active (last 30d)" value={snap.activeShops} accent="info" />
            </div>

            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>By Plan</div>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Plan</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right" as const }}>Shops</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right" as const }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(snap.shopsByPlan as ShopsByPlan).map(([plan, count]) => (
                  <tr key={plan}>
                    <td style={styles.tableCell}>{planLabel(plan)}</td>
                    <td style={{ ...styles.tableCell, textAlign: "right" as const }}>{count}</td>
                    <td style={{ ...styles.tableCell, textAlign: "right" as const }}>
                      {snap.totalShops > 0 ? pct((count as number) / snap.totalShops) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ----------------------------------------------------------------
              Section 2: Scan Metrics
          ---------------------------------------------------------------- */}
          <div style={sectionCard}>
            <SectionHeading>Scan Metrics</SectionHeading>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "12px",
              }}
            >
              <MetricTile label="All-Time Scans" value={snap.totalScans} />
              <MetricTile label="Scans Last 7d" value={snap.scansLast7d} />
              <MetricTile label="Scans Last 30d" value={snap.scansLast30d} />
              <MetricTile
                label="Completion Rate (30d)"
                value={pct(snap.completionRate)}
                accent={snap.completionRate < 0.8 ? "warning" : "success"}
              />
            </div>
          </div>

          {/* ----------------------------------------------------------------
              Section 3: Finding Metrics
          ---------------------------------------------------------------- */}
          <div style={sectionCard}>
            <SectionHeading>Finding Metrics</SectionHeading>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "12px",
              }}
            >
              <MetricTile label="Total Findings (All-Time)" value={snap.totalFindings} />
              <MetricTile label="Avg Findings / Scan" value={snap.avgFindingsPerScan.toFixed(1)} />
            </div>
          </div>
        </>
      )}

      {/* ----------------------------------------------------------------
          Section 4: Trend (last 30 snapshots)
      ---------------------------------------------------------------- */}
      {snapshotHistory.length > 0 && (
        <div style={sectionCard}>
          <SectionHeading>30-Day Trend</SectionHeading>
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Date</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right" as const }}>
                    Active Shops
                  </th>
                  <th style={{ ...styles.tableHeader, textAlign: "right" as const }}>Scans</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right" as const }}>
                    Completion Rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshotHistory.map((row) => (
                  <tr key={row.id}>
                    <td style={styles.tableCell}>{formatDate(new Date(row.snapshotDate))}</td>
                    <td style={{ ...styles.tableCell, textAlign: "right" as const }}>
                      {row.activeShops}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" as const }}>
                      {row.scansLast30d}
                    </td>
                    <td style={{ ...styles.tableCell, textAlign: "right" as const }}>
                      {pct(row.completionRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------
          Section 5: Manual Check Reminders
      ---------------------------------------------------------------- */}
      <div style={sectionCard}>
        <SectionHeading>Manual Checks</SectionHeading>
        <s-banner tone="info">
          The following metrics are not available via API and must be checked manually in the
          Shopify Partner Dashboard.
        </s-banner>
        <ul
          style={{
            marginTop: "16px",
            paddingLeft: "20px",
            lineHeight: "2",
            fontSize: "14px",
            color: TEXT_PRIMARY,
          }}
        >
          <li>
            <strong>Impressions &amp; installs</strong> — Apps &gt; Your App &gt; Analytics
          </li>
          <li>
            <strong>Reviews &amp; ratings</strong> — Apps &gt; Your App &gt; Reviews
          </li>
          <li>
            <strong>Ad performance</strong> — Apps &gt; Your App &gt; Advertising (if applicable)
          </li>
          <li>
            <strong>Revenue / payouts</strong> — Finances &gt; Payouts
          </li>
        </ul>
      </div>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

export function ErrorBoundary() {
  return (
    <s-page heading="Admin Metrics">
      <s-banner tone="critical">
        An error occurred loading the admin metrics dashboard. Check server logs for details.
      </s-banner>
    </s-page>
  );
}
