import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { getScanById, getPreviousScanForTheme } from "../models/scan.server";
import { getFindingSummary, getHighestSeverityFinding } from "../models/finding.server";
import { canViewFindingDetails, canUseScanDiffing } from "../lib/plan-gating.server";
import { diffScans } from "../services/scan-differ.server";
import type { ScanDiff } from "../services/scan-differ.server";
import { formatDate, statusTone, statusLabel } from "../lib/format";
import type { ScanStatus } from "../lib/format";

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
  ORPHAN_ASSET: "Orphan Assets",
};

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

  const scan = await getScanById(scanId);

  // Verify the scan exists and belongs to the authenticated shop.
  if (!scan || scan.shopId !== shop.id) {
    throw new Response("Not found", { status: 404 });
  }

  const findingSummary = await getFindingSummary(scanId);
  const canViewDetails = canViewFindingDetails(shop.plan);

  // For free-tier shops, omit the full findings array from the response
  // to avoid leaking detail data to the client. Paid users get the full array;
  // free users get null here (they receive previewFinding instead).
  const findings = canViewDetails ? scan.findings : [];

  // For free-tier shops, expose only the single highest-severity finding so
  // the UI can show a "peek" without leaking the full results.
  const previewFinding = canViewDetails ? null : await getHighestSeverityFinding(scanId);

  // Compute diff against the previous completed scan for the same theme,
  // but only when the current scan is itself completed and the plan allows it.
  let scanDiff: ScanDiff | null = null;
  if (scan.status === "COMPLETED" && canUseScanDiffing(shop.plan)) {
    const previousScan = await getPreviousScanForTheme(scan.shopId, scan.themeId, scan.createdAt);
    if (previousScan) {
      scanDiff = diffScans(scan.findings, previousScan.findings);
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
  const { scan, findings, previewFinding, findingSummary, canViewDetails, scanDiff } =
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
      <s-link slot="primary-action" href="/app/scans">
        Back to History
      </s-link>

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
        <s-stack direction="inline" gap="base">
          <s-badge tone={statusTone(status)}>{statusLabel(status)}</s-badge>
          <s-text>Started: {formatDate(scan.startedAt ?? scan.createdAt, true)}</s-text>
          {scan.completedAt && <s-text>Completed: {formatDate(scan.completedAt, true)}</s-text>}
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
            <a href="/app">
              <s-button variant="primary">Go to Dashboard</s-button>
            </a>
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
              <s-heading>Findings</s-heading>
              {findings.length === 0 ? (
                <s-paragraph>No ghost code detected in this scan.</s-paragraph>
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
                      <tr>
                        <td>
                          <s-badge tone={severityTone(previewFinding.severity)}>
                            {previewFinding.severity}
                          </s-badge>
                        </td>
                        <td>
                          {FINDING_TYPE_LABELS[previewFinding.findingType] ??
                            previewFinding.findingType.replace(/_/g, " ")}
                        </td>
                        <td>
                          <code>{previewFinding.filename}</code>
                        </td>
                        <td>{previewFinding.lineNumber}</td>
                        <td>{previewFinding.appName ?? "—"}</td>
                        <td>
                          <code>
                            {previewFinding.codeSnippet.length > 80
                              ? `${previewFinding.codeSnippet.slice(0, 80)}…`
                              : previewFinding.codeSnippet}
                          </code>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </s-data-table>

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
                      <a href="/app/settings">
                        <s-button variant="primary">Upgrade Plan</s-button>
                      </a>
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
