/**
 * Admin signature-submission review — internal operator view.
 *
 * Merchants submit "which app left this unknown script?" suggestions from the
 * scan detail page. Those land in the SignatureSubmission table. This route is
 * where an operator reviews them: group pending suggestions by CDN domain,
 * accept a whole domain at once (promoting it toward the signature DB), or
 * approve/reject individual submissions.
 *
 * Access is restricted to shop domains listed in ADMIN_SHOP_DOMAINS env var.
 * Non-admin shops receive a 403 response. This mirrors app.admin.metrics.tsx.
 *
 * URL: /app/admin/submissions
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { isAdminShop } from "../lib/admin-gate.server";
import { formatDate } from "../lib/format";
import { logger } from "../lib/logger.server";
import { getShopMetadata } from "../models/shop.server";
import {
  acceptSubmissionsForDomain,
  getSubmissionStats,
  getSubmissionsByDomain,
  listSubmissionsForReview,
  updateSubmissionStatus,
} from "../models/unknown-script.server";
import { authenticate } from "../shopify.server";
import {
  STATUS_TINTS,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  sectionCard,
  sectionHeader,
  styles,
} from "../styles/shared";

// ---------------------------------------------------------------------------
// Admin gate — identical structure to app.admin.metrics.tsx
// ---------------------------------------------------------------------------

async function requireAdmin(request: Request): Promise<string> {
  const { session } = await authenticate.admin(request);

  const shop = await getShopMetadata(session.shop);
  if (!shop || !isAdminShop(session.shop)) {
    throw new Response("Forbidden", { status: 403 });
  }

  return session.shop;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shopDomain = await requireAdmin(request);

  const [stats, domainGroups, pendingSubmissions] = await Promise.all([
    getSubmissionStats(),
    getSubmissionsByDomain({ status: "PENDING" }),
    listSubmissionsForReview({ status: "PENDING" }),
  ]);

  return {
    shopDomain,
    stats,
    domainGroups,
    pendingSubmissions,
  };
};

// ---------------------------------------------------------------------------
// Action — moderation (accept a domain, or approve/reject one submission)
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const shopDomain = await requireAdmin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "acceptDomain") {
    const domain = (formData.get("domain") as string | null)?.trim();
    if (!domain) {
      return { error: "Domain is required" };
    }

    const result = await acceptSubmissionsForDomain(domain);
    logger.info("admin-submissions-accept-domain", {
      shopDomain,
      domain,
      accepted: result.count,
    });
    return { ok: true, accepted: result.count };
  }

  if (intent === "updateStatus") {
    const submissionId = (formData.get("submissionId") as string | null)?.trim();
    const status = formData.get("status");
    if (!submissionId) {
      return { error: "Submission id is required" };
    }
    if (status !== "ACCEPTED" && status !== "REJECTED") {
      return { error: "Invalid status" };
    }

    await updateSubmissionStatus(submissionId, status);
    logger.info("admin-submissions-update-status", { shopDomain, submissionId, status });
    return { ok: true };
  }

  return { error: "Unknown action" };
};

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        border: `1px solid ${STATUS_TINTS.info.border}`,
        background: STATUS_TINTS.info.bg,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: "13px", color: TEXT_SUBDUED, marginBottom: "4px" }}>{label}</div>
      <div style={{ fontSize: "24px", fontWeight: 700, lineHeight: 1, color: TEXT_PRIMARY }}>
        {value}
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 style={{ ...sectionHeader, marginTop: "24px" }}>{children}</h2>;
}

function statusTone(status: string): "info" | "success" | "critical" {
  if (status === "ACCEPTED") return "success";
  if (status === "REJECTED") return "critical";
  return "info";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminSubmissions() {
  const { stats, domainGroups, pendingSubmissions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";

  return (
    <s-page heading="Signature Submission Review">
      {/* ------------------------------------------------------------------
          Stats
      ------------------------------------------------------------------ */}
      <div style={sectionCard}>
        <SectionHeading>Overview</SectionHeading>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "12px",
          }}
        >
          <StatTile label="Total" value={stats.total} />
          <StatTile label="Pending" value={stats.pending} />
          <StatTile label="Accepted" value={stats.accepted} />
          <StatTile label="Rejected" value={stats.rejected} />
        </div>
      </div>

      {/* ------------------------------------------------------------------
          Pending by domain — bulk accept
      ------------------------------------------------------------------ */}
      <div style={sectionCard}>
        <SectionHeading>Pending by Domain</SectionHeading>
        {domainGroups.length === 0 ? (
          <s-banner tone="info">No pending submissions to review.</s-banner>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Domain</th>
                  <th style={{ ...styles.tableHeader, textAlign: "right" as const }}>Count</th>
                  <th style={styles.tableHeader}>Top Suggested Names</th>
                  <th style={styles.tableHeader}>Sample URLs</th>
                  <th style={styles.tableHeader}>Action</th>
                </tr>
              </thead>
              <tbody>
                {domainGroups.map((group) => (
                  <tr key={group.domain}>
                    <td style={styles.tableCell}>{group.domain}</td>
                    <td style={{ ...styles.tableCell, textAlign: "right" as const }}>
                      {group.submissionCount}
                    </td>
                    <td style={styles.tableCell}>
                      {group.suggestedNames
                        .slice(0, 3)
                        .map((n) => `${n.name} (${n.count})`)
                        .join(", ")}
                    </td>
                    <td style={{ ...styles.tableCell, fontSize: "12px", color: TEXT_SUBDUED }}>
                      {group.sampleUrls.map((u) => (
                        <div key={u}>{u}</div>
                      ))}
                    </td>
                    <td style={styles.tableCell}>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="acceptDomain" />
                        <input type="hidden" name="domain" value={group.domain} />
                        <s-button variant="primary" disabled={isBusy} type="submit">
                          Accept domain
                        </s-button>
                      </fetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------
          Individual pending submissions — approve / reject
      ------------------------------------------------------------------ */}
      <div style={sectionCard}>
        <SectionHeading>Pending Submissions</SectionHeading>
        {pendingSubmissions.length === 0 ? (
          <s-banner tone="info">No pending submissions.</s-banner>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.tableHeader}>Suggested App</th>
                  <th style={styles.tableHeader}>Domain</th>
                  <th style={styles.tableHeader}>File</th>
                  <th style={styles.tableHeader}>Submitted</th>
                  <th style={styles.tableHeader}>Status</th>
                  <th style={styles.tableHeader}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingSubmissions.map((sub) => (
                  <tr key={sub.id}>
                    <td style={styles.tableCell}>{sub.suggestedAppName}</td>
                    <td style={styles.tableCell}>{sub.domain ?? "—"}</td>
                    <td style={{ ...styles.tableCell, fontSize: "12px", color: TEXT_SUBDUED }}>
                      {sub.filename}
                    </td>
                    <td style={styles.tableCell}>{formatDate(new Date(sub.createdAt))}</td>
                    <td style={styles.tableCell}>
                      <s-badge tone={statusTone(sub.status)}>{sub.status}</s-badge>
                    </td>
                    <td style={styles.tableCell}>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <fetcher.Form method="post">
                          <input type="hidden" name="intent" value="updateStatus" />
                          <input type="hidden" name="submissionId" value={sub.id} />
                          <input type="hidden" name="status" value="ACCEPTED" />
                          <s-button variant="primary" disabled={isBusy} type="submit">
                            Approve
                          </s-button>
                        </fetcher.Form>
                        <fetcher.Form method="post">
                          <input type="hidden" name="intent" value="updateStatus" />
                          <input type="hidden" name="submissionId" value={sub.id} />
                          <input type="hidden" name="status" value="REJECTED" />
                          <s-button disabled={isBusy} type="submit">
                            Reject
                          </s-button>
                        </fetcher.Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

export function ErrorBoundary() {
  return (
    <s-page heading="Signature Submission Review">
      <s-banner tone="critical">
        An error occurred loading the submission review page. Check server logs for details.
      </s-banner>
    </s-page>
  );
}
