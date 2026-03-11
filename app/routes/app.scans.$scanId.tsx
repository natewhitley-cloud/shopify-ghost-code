import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { getScanById } from "../models/scan.server";
import { getFindingSummary } from "../models/finding.server";
import { canViewFindingDetails } from "../lib/plan-gating.server";

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

function severityTone(
  severity: string,
): "critical" | "warning" | "info" {
  switch (severity) {
    case "HIGH":
      return "critical";
    case "MEDIUM":
      return "warning";
    default:
      return "info";
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { scanId } = params;

  if (!scanId) {
    throw new Response("Scan ID is required", { status: 400 });
  }

  const scan = await getScanById(scanId);

  if (!scan) {
    throw new Response("Scan not found", { status: 404 });
  }

  // Verify the scan belongs to the authenticated shop.
  const shop = await getShopByDomain(session.shop);
  if (!shop || scan.shopId !== shop.id) {
    throw new Response("Not found", { status: 404 });
  }

  const findingSummary = await getFindingSummary(scanId);
  const canViewDetails = canViewFindingDetails(shop.plan);

  // For free-tier shops, omit the full findings array from the response
  // to avoid leaking detail data to the client.
  const findings = canViewDetails ? scan.findings : [];

  return {
    scan: {
      id: scan.id,
      themeName: scan.themeName,
      status: scan.status,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      createdAt: scan.createdAt,
      findingCount: scan.findingCount,
    },
    findings,
    findingSummary,
    canViewDetails,
  };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScanDetail() {
  const { scan, findings, findingSummary, canViewDetails } =
    useLoaderData<typeof loader>();

  const revalidator = useRevalidator();

  // Poll the loader every 3 seconds while the scan is still running.
  useEffect(() => {
    if (
      scan.status === "PENDING" ||
      scan.status === "IN_PROGRESS"
    ) {
      const interval = setInterval(() => {
        revalidator.revalidate();
      }, 3000);
      return () => clearInterval(interval);
    }
    // No cleanup needed when the scan is in a terminal state.
    return undefined;
  }, [scan.status, revalidator]);

  const status = scan.status as ScanStatus;
  const summary = findingSummary.bySeverity;

  return (
    <s-page heading={`Scan: ${scan.themeName}`}>
      <s-link slot="primary-action" href="/app/scans">
        Back to History
      </s-link>

      {/* Scan status header */}
      <s-card>
        <s-stack direction="inline" gap="base">
          <s-badge tone={statusTone(status)}>
            {statusLabel(status)}
          </s-badge>
          <s-text>Started: {formatDate(scan.startedAt ?? scan.createdAt)}</s-text>
          {scan.completedAt && (
            <s-text>Completed: {formatDate(scan.completedAt)}</s-text>
          )}
        </s-stack>
      </s-card>

      {/* Findings summary — always visible regardless of plan */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-heading>Findings Summary</s-heading>
          <s-stack direction="inline" gap="base">
            <s-badge tone="critical">{summary.HIGH} High</s-badge>
            <s-badge tone="warning">{summary.MEDIUM} Medium</s-badge>
            <s-badge tone="info">{summary.LOW} Low</s-badge>
          </s-stack>
        </s-stack>
      </s-card>

      {/* Findings detail table (paid plans) or upgrade prompt (free) */}
      {canViewDetails ? (
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Findings</s-heading>
            {findings.length === 0 ? (
              <s-paragraph>
                {scan.status === "COMPLETED"
                  ? "No ghost code detected in this scan."
                  : "Findings will appear here once the scan completes."}
              </s-paragraph>
            ) : (
              <s-data-table>
                <table>
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Type</th>
                      <th>File</th>
                      <th>Line</th>
                      <th>App</th>
                      <th>Snippet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((finding) => (
                      <tr key={finding.id}>
                        <td>
                          <s-badge tone={severityTone(finding.severity)}>
                            {finding.severity}
                          </s-badge>
                        </td>
                        <td>{finding.findingType.replace(/_/g, " ")}</td>
                        <td>
                          <code>{finding.filename}</code>
                        </td>
                        <td>{finding.lineNumber}</td>
                        <td>{finding.appName ?? "—"}</td>
                        <td>
                          <code>
                            {finding.codeSnippet.length > 80
                              ? `${finding.codeSnippet.slice(0, 80)}…`
                              : finding.codeSnippet}
                          </code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </s-data-table>
            )}
          </s-stack>
        </s-card>
      ) : (
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Upgrade to see details</s-heading>
            <s-paragraph>
              The free plan shows finding counts only. Upgrade to Standard to
              see full details including file names, line numbers, and code
              snippets.
            </s-paragraph>
            <s-button variant="primary">Upgrade Plan</s-button>
          </s-stack>
        </s-card>
      )}
    </s-page>
  );
}
