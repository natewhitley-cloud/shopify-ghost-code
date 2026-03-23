import type { Finding } from "@prisma/client";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRevalidator } from "react-router";

import { formatDate, statusTone, statusLabel } from "../lib/format";
import type { ScanStatus } from "../lib/format";
import { computeHealthScore } from "../lib/health-score";
import { sortFindingsBySeverity, sortDiffFindingsBySeverity } from "../lib/finding-sort";
import type { HealthScoreResult } from "../lib/health-score";
import { canViewFindingDetails, canUseScanDiffing } from "../lib/plan-gating.server";
import { getFindingSummary, getHighestSeverityFinding } from "../models/finding.server";
import { getScanById, getPreviousScanForTheme } from "../models/scan.server";
import { getShopByDomain } from "../models/shop.server";
import type { ScanDiff } from "../services/scan-differ.server";
import { diffScans } from "../services/scan-differ.server";
import { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityTone(severity: string): "critical" | "warning" | "info" {
  switch (severity) {
    case "HIGH":
      return "critical";
    case "MEDIUM":
      return "warning";
    default:
      return "info";
  }
}

const FINDING_TYPE_LABELS: Record<string, string> = {
  GHOST_SCRIPT: "Scripts",
  GHOST_STYLE: "Styles",
  GHOST_SNIPPET: "Snippets",
  GHOST_SECTION: "Sections",
  GHOST_HREFLANG: "Hreflang Tags",
  ORPHAN_ASSET: "Orphan Assets",
  DUPLICATE_META: "Duplicate Meta Tags",
};

// ---------------------------------------------------------------------------
// Shared finding table components
// ---------------------------------------------------------------------------

interface FindingLike {
  severity: string;
  findingType: string;
  filename: string;
  lineNumber: number;
  appName: string | null;
  codeSnippet: string;
}

function FindingRow({ finding }: { finding: FindingLike }) {
  return (
    <tr>
      <td>
        <s-badge tone={severityTone(finding.severity)}>{finding.severity}</s-badge>
      </td>
      <td>{FINDING_TYPE_LABELS[finding.findingType] ?? finding.findingType.replace(/_/g, " ")}</td>
      <td>
        <code style={{ fontSize: "12px" }}>{finding.filename}</code>
      </td>
      <td style={{ textAlign: "center" }}>{finding.lineNumber}</td>
      <td>{finding.appName ?? "—"}</td>
      <td>
        <code style={{ fontSize: "12px", wordBreak: "break-word" }}>
          {finding.codeSnippet.length > 80
            ? `${finding.codeSnippet.slice(0, 80)}…`
            : finding.codeSnippet}
        </code>
      </td>
    </tr>
  );
}

const FINDINGS_TABLE_STYLES = `
  .findings-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .findings-table th,
  .findings-table td {
    border: 1px solid #e1e3e5;
    padding: 8px 12px;
    text-align: left;
    vertical-align: top;
  }
  .findings-table thead th {
    background: #f6f6f7;
    font-weight: 600;
    white-space: nowrap;
    position: sticky;
    top: 0;
  }
  .findings-table tbody tr:nth-child(even) {
    background: #fafbfb;
  }
  .findings-table tbody tr:hover {
    background: #f1f2f3;
  }
  .findings-table td:nth-child(1) { width: 80px; }
  .findings-table td:nth-child(2) { width: 100px; white-space: nowrap; }
  .findings-table td:nth-child(3) { width: 200px; }
  .findings-table td:nth-child(4) { width: 50px; text-align: center; }
  .findings-table td:nth-child(5) { width: 100px; }
  .findings-table td:nth-child(6) { max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
`;

function FindingsTable({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{FINDINGS_TABLE_STYLES}</style>
      <table className="findings-table">
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
        <tbody>{children}</tbody>
      </table>
    </>
  );
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

  // Verify the authenticated shop exists before fetching the scan.
  const shop = await getShopByDomain(session.shop);
  if (!shop) {
    throw new Response("Not found", { status: 404 });
  }

  // Determine plan gating before querying the scan so we can skip the
  // findings JOIN for free-tier shops that cannot view finding details.
  const canViewDetails = canViewFindingDetails(shop.plan);

  const scan = await getScanById(scanId, { includeFindings: canViewDetails });

  // Verify the scan exists and belongs to the authenticated shop.
  if (!scan || scan.shopId !== shop.id) {
    throw new Response("Not found", { status: 404 });
  }

  const findingSummary = await getFindingSummary(scanId);

  // Compute health score for completed scans.
  let healthScore: HealthScoreResult | null = null;
  if (scan.status === "COMPLETED") {
    healthScore = computeHealthScore(findingSummary.bySeverity);
  }

  // For free-tier shops, omit the full findings array from the response to
  // avoid leaking detail data to the client. Paid users get the full array;
  // free users get an empty array (they receive previewFinding instead).
  // When canViewDetails is false, getScanById was called without includeFindings
  // so scan.findings is undefined — fall through to the empty array default.
  const findings: Finding[] =
    canViewDetails && "findings" in scan ? (scan.findings as Finding[]) : [];

  // Sort findings by severity (HIGH → MEDIUM → LOW), then by type, file, line.
  sortFindingsBySeverity(findings);

  // For free-tier shops, expose only the single highest-severity finding so
  // the UI can show a "peek" without leaking the full results.
  const previewFinding = canViewDetails ? null : await getHighestSeverityFinding(scanId);

  // Compute diff against the previous completed scan for the same theme,
  // but only when the current scan is itself completed and the plan allows it.
  // scanDiffing is only enabled for plans that also have showFindingDetails,
  // so `findings` is guaranteed to be populated when this branch is reached.
  let scanDiff: ScanDiff | null = null;
  if (scan.status === "COMPLETED" && canUseScanDiffing(shop.plan)) {
    const previousScan = await getPreviousScanForTheme(scan.shopId, scan.themeId, scan.createdAt);
    if (previousScan) {
      scanDiff = diffScans(findings, previousScan.findings);
      // Sort diff finding arrays by severity for consistent display order.
      sortDiffFindingsBySeverity(scanDiff.newFindings);
      sortDiffFindingsBySeverity(scanDiff.resolvedFindings);
    }
  }

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
    previewFinding,
    findingSummary,
    canViewDetails,
    scanDiff,
    healthScore,
  };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Maximum number of 3-second polls before we give up (~10 minutes).
const MAX_POLL_COUNT = 200;

// The `shopify` global is injected by Shopify App Bridge in embedded app context.
declare const shopify: {
  toast: { show: (msg: string, opts?: { isError?: boolean; duration?: number }) => void };
};

export default function ScanDetail() {
  const { scan, findings, previewFinding, findingSummary, canViewDetails, scanDiff, healthScore } =
    useLoaderData<typeof loader>();

  const revalidator = useRevalidator();

  // Track how many polls have been fired so we can enforce a timeout ceiling.
  const pollCount = useRef(0);

  // Whether polling timed out (only true when we hit MAX_POLL_COUNT).
  const [pollingTimedOut, setPollingTimedOut] = useState(false);

  // Remember the status at mount time so we can detect transitions.
  // We deliberately want this to stay at the initial value — the ref does not
  // update on re-render so that we can compare "was it in progress?" vs "is it
  // now terminal?".
  const statusAtMount = useRef(scan.status);

  // Toast on completion / failure — but only when the scan transitioned while
  // this page was open (i.e. mount status was non-terminal, current is terminal).
  useEffect(() => {
    const mountedWhileRunning =
      statusAtMount.current === "PENDING" || statusAtMount.current === "IN_PROGRESS";

    if (!mountedWhileRunning) return;

    if (scan.status === "COMPLETED") {
      shopify.toast.show("Scan completed successfully.", { duration: 5000 });
    } else if (scan.status === "FAILED") {
      shopify.toast.show("Scan failed. Please try running it again.", {
        isError: true,
        duration: 5000,
      });
    }
    // We only want this to fire when the status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.status]);

  // Poll the loader every 3 seconds while the scan is still running,
  // stopping after MAX_POLL_COUNT polls (~10 minutes).
  useEffect(() => {
    const isRunning = scan.status === "PENDING" || scan.status === "IN_PROGRESS";

    if (!isRunning) {
      // Terminal state — reset poll counter so a future navigation back resets cleanly.
      pollCount.current = 0;
      return undefined;
    }

    // Already timed out from a previous render cycle — don't restart polling.
    if (pollingTimedOut) return undefined;

    const interval = setInterval(() => {
      pollCount.current += 1;

      if (pollCount.current >= MAX_POLL_COUNT) {
        clearInterval(interval);
        setPollingTimedOut(true);
        return;
      }

      revalidator.revalidate();
    }, 3000);

    return () => clearInterval(interval);
    // revalidator reference is stable across renders; scan.status and
    // pollingTimedOut are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.status, pollingTimedOut]);

  const status = scan.status as ScanStatus;
  const summary = findingSummary.bySeverity;

  const isFailed = scan.status === "FAILED";
  const isRunning = scan.status === "PENDING" || scan.status === "IN_PROGRESS";
  const isCompleted = scan.status === "COMPLETED";

  return (
    <s-page heading={`Scan: ${scan.themeName}`}>
      <Link to="/app/scans" slot="primary-action">
        Back to History
      </Link>

      {/* Polling timeout notice — shown when we stopped polling after 10 minutes */}
      {pollingTimedOut && (
        <s-banner tone="warning">
          Scan is taking longer than expected. Refresh the page to check the latest status.
        </s-banner>
      )}

      {/* FAILED state banner — prominent error message for merchants */}
      {isFailed && (
        <s-banner tone="critical">
          This scan failed to complete. Please try running a new scan from the dashboard.
        </s-banner>
      )}

      {/* Scan status header */}
      <s-card>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-badge tone={statusTone(status)}>{statusLabel(status)}</s-badge>
            <s-text>Started: {formatDate(scan.startedAt ?? scan.createdAt, true)}</s-text>
            {scan.completedAt && <s-text>Completed: {formatDate(scan.completedAt, true)}</s-text>}
          </s-stack>
          {/* Health score — only shown for completed scans */}
          {isCompleted && healthScore && (
            <s-stack direction="inline" gap="base">
              <s-text>Theme Health Score:</s-text>
              <s-heading>{healthScore.score}</s-heading>
              <s-badge tone={healthScore.tone}>{healthScore.label}</s-badge>
            </s-stack>
          )}
        </s-stack>
      </s-card>

      {/* Findings summary — conditional on scan state */}
      {isFailed ? (
        /* FAILED: replace summary with an explanation card */
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Scan Did Not Complete</s-heading>
            <s-paragraph>
              Findings are unavailable because this scan encountered an error before finishing.
              Start a new scan from the dashboard to get up-to-date results.
            </s-paragraph>
            <Link to="/app">
              <s-button variant="primary">Go to Dashboard</s-button>
            </Link>
          </s-stack>
        </s-card>
      ) : isRunning ? (
        /* IN_PROGRESS / PENDING: show a loading placeholder instead of zero counts */
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Scan In Progress</s-heading>
            <s-paragraph>
              Your theme is being scanned. Findings will appear here automatically when the scan
              completes — no need to refresh.
            </s-paragraph>
          </s-stack>
        </s-card>
      ) : (
        /* COMPLETED: normal findings summary */
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
      )}

      {/* Changes from last scan — only shown for completed scans with a diff */}
      {isCompleted && scanDiff !== null && (
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Changes from Last Scan</s-heading>
            <s-stack direction="inline" gap="base">
              <s-badge tone="critical">{scanDiff.newFindings.length} New</s-badge>
              <s-badge tone="success">{scanDiff.resolvedFindings.length} Resolved</s-badge>
              <s-badge tone="info">{scanDiff.unchangedCount} Unchanged</s-badge>
            </s-stack>
          </s-stack>
        </s-card>
      )}

      {/* Findings detail table — only shown for completed scans */}
      {isCompleted &&
        (canViewDetails ? (
          <s-card>
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-heading>Findings</s-heading>
                {findings.length > 0 && (
                  <s-link href={`/app/scans/${scan.id}/export?format=csv`}>
                    <s-button>Export CSV</s-button>
                  </s-link>
                )}
              </s-stack>
              {findings.length === 0 ? (
                <s-paragraph>No ghost code detected in this scan.</s-paragraph>
              ) : (
                <FindingsTable>
                  {findings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} />
                  ))}
                </FindingsTable>
              )}
            </s-stack>
          </s-card>
        ) : previewFinding === null ? (
          /* Free tier, no findings at all */
          <s-card>
            <s-paragraph>No ghost code detected in this scan.</s-paragraph>
          </s-card>
        ) : (
          /* Free tier with findings — show summary + one preview row + upgrade prompt */
          <>
            {/* Summary header: total count + category breakdown */}
            <s-card>
              <s-stack direction="block" gap="base">
                <s-heading>{findingSummary.total} findings detected</s-heading>
                <s-stack direction="inline" gap="base">
                  {(Object.entries(findingSummary.byType) as [string, number][])
                    .filter(([, count]) => count > 0)
                    .map(([type, count]) => (
                      <s-badge key={type} tone="neutral">
                        {FINDING_TYPE_LABELS[type] ?? type}: {count}
                      </s-badge>
                    ))}
                </s-stack>
              </s-stack>
            </s-card>

            {/* Preview finding — one row shown as a mini data table */}
            <s-card>
              <s-stack direction="block" gap="base">
                <s-heading>Preview: Highest Severity Finding</s-heading>
                <FindingsTable>
                  <FindingRow finding={previewFinding} />
                </FindingsTable>

                {/* Upgrade banner: remaining count and upgrade CTA (hidden when only 1 finding total) */}
                {findingSummary.total > 1 && (
                  <s-banner tone="info">
                    <s-stack direction="block" gap="base">
                      <s-text>
                        {findingSummary.total - 1} more{" "}
                        {findingSummary.total - 1 === 1 ? "finding" : "findings"} detected. Upgrade
                        to Standard to see full details including all file names, line numbers, and
                        code snippets.
                      </s-text>
                      <Link to="/app/settings">
                        <s-button variant="primary">Upgrade Plan</s-button>
                      </Link>
                    </s-stack>
                  </s-banner>
                )}
              </s-stack>
            </s-card>
          </>
        ))}
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
