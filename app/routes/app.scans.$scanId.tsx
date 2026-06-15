import type { Finding } from "@prisma/client";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRevalidator, useFetcher } from "react-router";

import { hasVisualImpact } from "../lib/finding-classification";
import { sortFindingsBySeverity, sortDiffFindingsBySeverity } from "../lib/finding-sort";
import { formatDate, statusTone, statusLabel, isSuccessfulScan } from "../lib/format";
import type { ScanStatus } from "../lib/format";
import { computeHealthScore } from "../lib/health-score";
import type { HealthScoreResult } from "../lib/health-score";
import { canViewFindingDetails, canUseScanDiffing } from "../lib/plan-gating.server";
import { getFindingSummary, getHighestSeverityFinding } from "../models/finding.server";
import { getScanById, getPreviousScanForTheme } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import {
  findUnknownScriptForShop,
  getUnknownScriptsForScan,
  submitSignatureSuggestion,
} from "../models/unknown-script.server";
import { isTrackerApp } from "../services/app-lookup.server";
import type { ScanDiff } from "../services/scan-differ.server";
import { diffScans } from "../services/scan-differ.server";
import { authenticate } from "../shopify.server";
import {
  BG_SURFACE,
  BG_WHITE,
  COLOR_CRITICAL,
  STATUS_TINTS,
  TEXT_SUBDUED,
  styles,
} from "../styles/shared";

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
  GHOST_JSON_LD: "JSON-LD Schema",
  GHOST_TEXT: "Widget Text",
  GHOST_TRANSLATION: "Translations",
  SETTINGS_DRIFT: "Settings Drift",
  GHOST_PIXEL: "Tracking Pixels",
  JSON_LD_CONFLICT: "JSON-LD Conflicts",
  GHOST_LAYOUT: "Layout Code",
  GHOST_TAG: "Theme Tags",
  GHOST_PRICE: "Price Markup",
  GHOST_PAGE: "Page Templates",
  GHOST_METAFIELD: "Metafields",
  GHOST_REDIRECT: "Redirects",
  GHOST_ROBOTS: "Robots.txt Rules",
  GHOST_CANONICAL: "Canonical Tags",
  GHOST_TITLE: "Title Tags",
  GHOST_OG: "Open Graph Tags",
  GHOST_PRECONNECT: "Preconnect Hints",
  GHOST_FONT: "Font References",
  GHOST_AJAX: "AJAX Requests",
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
  isTracker?: boolean;
  isVisual?: boolean;
}

function FindingRow({ finding, isNew }: { finding: FindingLike; isNew?: boolean }) {
  const isVisual = finding.isVisual ?? hasVisualImpact(finding.findingType);
  return (
    <tr>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <s-badge tone={severityTone(finding.severity)}>{finding.severity}</s-badge>
          {isNew && <span style={styles.newBadge}>NEW</span>}
          {finding.isTracker && <span style={styles.trackerBadge}>TRACKING</span>}
          {isVisual && <span style={styles.visualBadge}>VISUAL</span>}
        </div>
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
    background: #edeeef;
    font-weight: 600;
    white-space: nowrap;
    position: sticky;
    top: 0;
    border-bottom: 2px solid #c9cccf;
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
  const shop = await getShopMetadata(session.shop);
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

  // Group 1: independent queries that only require `scan` to be resolved.
  const [findingSummary, rawPreviewFinding, previousScan, unknownScripts] = await Promise.all([
    getFindingSummary(scanId),
    // Free-tier only: fetch a single preview finding (paid users get full array).
    canViewDetails ? Promise.resolve(null) : getHighestSeverityFinding(scanId),
    // Diff: only needed for successful scans on plans that support diffing.
    isSuccessfulScan(scan.status) && canUseScanDiffing(shop.plan)
      ? getPreviousScanForTheme(scan.shopId, scan.themeId, scan.createdAt)
      : Promise.resolve(null),
    // Unknown scripts: only for successful scans when user can view details.
    isSuccessfulScan(scan.status) && canViewDetails
      ? getUnknownScriptsForScan(scanId)
      : Promise.resolve([]),
  ]);

  // Group 2: depends on findingSummary from Group 1.
  // Compute health score for successful scans (COMPLETED or PARTIAL).
  let healthScore: HealthScoreResult | null = null;
  if (isSuccessfulScan(scan.status)) {
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

  // Enrich findings with tracker flag for privacy callout badges.
  const enrichedFindings = (findings ?? []).map((f) => ({
    ...f,
    isTracker: f.appName ? isTrackerApp(f.appName) : false,
  }));

  // Enrich the preview finding with tracker flag (free-tier only).
  const previewFinding = rawPreviewFinding
    ? {
        ...rawPreviewFinding,
        isTracker: rawPreviewFinding.appName ? isTrackerApp(rawPreviewFinding.appName) : false,
      }
    : null;

  // Compute diff against the previous completed scan for the same theme.
  // scanDiffing is only enabled for plans that also have showFindingDetails,
  // so `findings` is guaranteed to be populated when this branch is reached.
  let scanDiff: ScanDiff | null = null;
  if (previousScan) {
    // Exclude prior findings in categories THIS scan skipped for missing scope,
    // so an un-audited category is never reported as falsely "resolved" (LOG-4).
    scanDiff = diffScans(findings, previousScan.findings, {
      skippedCategories: scan.skippedCategories,
    });
    // Sort diff finding arrays by severity for consistent display order.
    sortDiffFindingsBySeverity(scanDiff.newFindings);
    sortDiffFindingsBySeverity(scanDiff.resolvedFindings);
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
    findings: enrichedFindings,
    previewFinding,
    findingSummary,
    canViewDetails,
    scanDiff,
    healthScore,
    unknownScripts,
  };
};

// ---------------------------------------------------------------------------
// Action — handles merchant feedback on unknown scripts
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopMetadata(session.shop);
  if (!shop) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const unknownScriptId = formData.get("unknownScriptId") as string;
  const suggestedAppName = formData.get("suggestedAppName") as string;

  if (!unknownScriptId || !suggestedAppName?.trim()) {
    return { error: "App name is required" };
  }

  const trimmed = suggestedAppName.trim();
  if (trimmed.length > 200) {
    return { error: "App name is too long" };
  }

  // Verify the unknown script belongs to a scan owned by this shop
  const unknownScript = await findUnknownScriptForShop(unknownScriptId, shop.id);
  if (!unknownScript) {
    return { error: "Unknown script not found" };
  }

  await submitSignatureSuggestion(unknownScriptId, shop.id, trimmed);
  return { success: true, unknownScriptId };
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

// ---------------------------------------------------------------------------
// Unknown script feedback row (each row has its own fetcher for independent
// submission state)
// ---------------------------------------------------------------------------

type UnknownScriptData = {
  id: string;
  filename: string;
  url: string;
  resourceType: string;
  submissions: Array<{ suggestedAppName: string }>;
};

function UnknownScriptRow({ script }: { script: UnknownScriptData }) {
  const fetcher = useFetcher<{ success?: boolean; unknownScriptId?: string }>();
  const isSubmitted = fetcher.data?.unknownScriptId === script.id || script.submissions.length > 0;
  const submittedName =
    script.submissions.length > 0
      ? script.submissions[0].suggestedAppName
      : (fetcher.formData?.get("suggestedAppName") as string | null);

  return (
    <tr>
      <td>
        <s-badge tone="neutral">
          {script.resourceType === "script" ? "Script" : "Stylesheet"}
        </s-badge>
      </td>
      <td>
        <code style={{ fontSize: "12px" }}>{script.filename}</code>
      </td>
      <td>
        <code style={{ fontSize: "12px", wordBreak: "break-all" }}>
          {script.url.length > 60 ? `${script.url.slice(0, 60)}...` : script.url}
        </code>
      </td>
      <td>
        {isSubmitted ? (
          <span style={{ color: STATUS_TINTS.success.text, fontWeight: 500 }}>
            Submitted{submittedName ? ` — ${submittedName}` : ""} — thank you!
          </span>
        ) : (
          <fetcher.Form method="post" style={{ display: "flex", gap: "4px" }}>
            <input type="hidden" name="unknownScriptId" value={script.id} />
            <input
              type="text"
              name="suggestedAppName"
              placeholder="App name..."
              required
              style={{
                padding: "4px 8px",
                border: "1px solid #c9cccf",
                borderRadius: "4px",
                fontSize: "12px",
                width: "120px",
              }}
            />
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              style={{
                padding: "4px 8px",
                border: "1px solid #c9cccf",
                borderRadius: "4px",
                fontSize: "12px",
                background: BG_SURFACE,
                cursor: "pointer",
              }}
            >
              {fetcher.state !== "idle" ? "..." : "Submit"}
            </button>
          </fetcher.Form>
        )}
      </td>
    </tr>
  );
}

export default function ScanDetail() {
  const {
    scan,
    findings,
    previewFinding,
    findingSummary,
    canViewDetails,
    scanDiff,
    healthScore,
    unknownScripts,
  } = useLoaderData<typeof loader>();

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

    if (isSuccessfulScan(scan.status)) {
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
  const isCompleted = isSuccessfulScan(scan.status);

  // Compute per-severity diff counts from scanDiff arrays.
  const severityDiff = scanDiff
    ? {
        newHigh: scanDiff.newFindings.filter((f) => f.severity === "HIGH").length,
        newMedium: scanDiff.newFindings.filter((f) => f.severity === "MEDIUM").length,
        newLow: scanDiff.newFindings.filter((f) => f.severity === "LOW").length,
        resolvedHigh: scanDiff.resolvedFindings.filter((f) => f.severity === "HIGH").length,
        resolvedMedium: scanDiff.resolvedFindings.filter((f) => f.severity === "MEDIUM").length,
        resolvedLow: scanDiff.resolvedFindings.filter((f) => f.severity === "LOW").length,
      }
    : null;

  // Net change per severity: positive = worse (more findings), negative = better.
  const severityNet = severityDiff
    ? {
        HIGH: severityDiff.newHigh - severityDiff.resolvedHigh,
        MEDIUM: severityDiff.newMedium - severityDiff.resolvedMedium,
        LOW: severityDiff.newLow - severityDiff.resolvedLow,
      }
    : null;

  const totalFindings = summary.HIGH + summary.MEDIUM + summary.LOW;
  const totalNew = scanDiff ? scanDiff.newFindings.length : 0;
  const totalResolved = scanDiff ? scanDiff.resolvedFindings.length : 0;

  // Performance impact: count external resources from uninstalled apps.
  const externalResourceCount = findings.filter(
    (f) => f.findingType === "GHOST_SCRIPT" || f.findingType === "GHOST_STYLE",
  ).length;
  const scriptCount = findings.filter((f) => f.findingType === "GHOST_SCRIPT").length;
  const styleCount = findings.filter((f) => f.findingType === "GHOST_STYLE").length;

  // Build app attribution map: appName -> { files, findingCount, findingTypes }
  const appAttribution = new Map<
    string,
    { files: Set<string>; count: number; types: Set<string> }
  >();
  for (const f of findings) {
    if (!f.appName) continue;
    if (!appAttribution.has(f.appName)) {
      appAttribution.set(f.appName, { files: new Set(), count: 0, types: new Set() });
    }
    const entry = appAttribution.get(f.appName)!;
    entry.files.add(f.filename);
    entry.count++;
    entry.types.add(f.findingType);
  }

  // Build a Set of fingerprints for new findings so we can tag rows in the table.
  const newFindingKeys = new Set(
    scanDiff
      ? scanDiff.newFindings.map(
          (f) => `${f.findingType}|${f.filename}|${f.severity}|${f.appName ?? ""}`,
        )
      : [],
  );

  /**
   * Map HealthScoreResult tone to the CSS modifier used in tile classes.
   * The health score tone can be "success", "warning", "critical", "caution", or "info".
   * We map caution/info to warning for tile styling since we only have three visual tiers.
   */
  function healthToneModifier(tone: string): "success" | "warning" | "critical" {
    if (tone === "success") return "success";
    if (tone === "critical") return "critical";
    return "warning";
  }

  return (
    <s-page heading={`Scan: ${scan.themeName}`}>
      <Link to="/app/scans" slot="primary-action">
        Back to History
      </Link>

      <style>{`
        .scan-status-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 13px;
          color: #6d7175;
          padding: 8px 0;
          flex-wrap: wrap;
        }
        .scan-status-bar__separator {
          color: #c9cccf;
        }
        .scan-section-title {
          font-size: 18px;
          font-weight: 600;
          color: #202223;
          margin: 0;
        }
        .scan-tiles-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-top: 8px;
          align-items: stretch;
        }
        @media (max-width: 640px) {
          .scan-tiles-row {
            grid-template-columns: 1fr;
          }
        }
        .scan-tile-wrapper {
          display: flex;
          flex-direction: column;
        }
        .scan-tile {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 24px;
          border-radius: 12px;
          border: 1px solid #e1e3e5;
          background: #ffffff;
          flex: 1;
        }
        .scan-tile--health-success {
          border-color: #c8e6c1;
          background: #f1f8ef;
        }
        .scan-tile--health-warning {
          border-color: #fdf0cd;
          background: #fffcf2;
        }
        .scan-tile--health-critical {
          border-color: #fde8e8;
          background: #fef6f6;
        }
        .scan-tile__big-number {
          font-size: 48px;
          font-weight: 700;
          line-height: 1;
          letter-spacing: -2px;
        }
        .scan-tile__big-number--success { color: #1a8a3f; }
        .scan-tile__big-number--warning { color: #b98900; }
        .scan-tile__big-number--critical { color: #d72c0d; }
        .scan-tile__big-number--neutral { color: #202223; }
        .scan-tile__subtitle {
          font-size: 14px;
          color: #6d7175;
          margin-top: 4px;
        }
        .scan-tile__label {
          display: inline-block;
          margin-top: 12px;
          padding: 4px 12px;
          border-radius: 16px;
          font-size: 13px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .scan-tile__label--success { background: #e3f1df; color: #1a8a3f; }
        .scan-tile__label--warning { background: #fdf0cd; color: #916a00; }
        .scan-tile__label--critical { background: #fde8e8; color: #d72c0d; }
        .scan-tile__diff {
          font-size: 13px;
          margin-top: 8px;
        }
        .scan-tile__diff--positive { color: #d72c0d; }
        .scan-tile__diff--negative { color: #1a8a3f; }
        .scan-tile__diff--neutral { color: #6d7175; }
        .severity-breakdown {
          display: flex;
          flex-direction: column;
          gap: 0;
          width: 100%;
        }
        .severity-breakdown__header {
          display: flex;
          justify-content: space-between;
          padding-bottom: 8px;
          margin-bottom: 12px;
          border-bottom: 1px solid #e1e3e5;
          font-size: 11px;
          font-weight: 600;
          color: #8c9196;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .severity-row {
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .severity-row__left {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .severity-row__count {
          font-size: 24px;
          font-weight: 700;
          line-height: 1;
          min-width: 32px;
        }
        .severity-row__count--high { color: #d72c0d; }
        .severity-row__count--medium { color: #b98900; }
        .severity-row__count--low { color: #2c6ecb; }
        .severity-row__label {
          font-size: 14px;
          font-weight: 500;
          color: #6d7175;
        }
        .severity-row__dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .severity-row__dot--high { background: #d72c0d; }
        .severity-row__dot--medium { background: #b98900; }
        .severity-row__dot--low { background: #2c6ecb; }
        .severity-row__diff {
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
        }
        .severity-row__diff--positive { color: #d72c0d; }
        .severity-row__diff--negative { color: #1a8a3f; }
        .severity-row__diff--neutral { color: #8c9196; }
      `}</style>

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

      {/* Row 1: Status bar — compact metadata line */}
      <div className="scan-status-bar">
        <s-badge tone={statusTone(status)}>{statusLabel(status)}</s-badge>
        <span className="scan-status-bar__separator">|</span>
        <span>Started {formatDate(scan.startedAt ?? scan.createdAt, true)}</span>
        {scan.completedAt && (
          <>
            <span className="scan-status-bar__separator">|</span>
            <span>Completed {formatDate(scan.completedAt, true)}</span>
          </>
        )}
      </div>

      {/* Row 2: Summary tiles — conditional on scan state */}
      {isFailed ? (
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
        <div className="scan-tiles-row">
          {/* Tile 1: Health Score */}
          {healthScore && (
            <div className="scan-tile-wrapper">
              <h2 className="scan-section-title">Theme Health</h2>
              <div
                className={`scan-tile scan-tile--health-${healthToneModifier(healthScore.tone)}`}
                style={{ marginTop: "8px" }}
              >
                <div
                  className={`scan-tile__big-number scan-tile__big-number--${healthToneModifier(healthScore.tone)}`}
                >
                  {healthScore.score}
                </div>
                <div className="scan-tile__subtitle">out of 100</div>
                <div
                  className={`scan-tile__label scan-tile__label--${healthToneModifier(healthScore.tone)}`}
                >
                  {healthScore.label}
                </div>
              </div>
            </div>
          )}

          {/* Tile 2: Total Findings */}
          <div className="scan-tile-wrapper">
            <h2 className="scan-section-title">Total Findings</h2>
            <div className="scan-tile" style={{ marginTop: "8px" }}>
              <div className="scan-tile__big-number scan-tile__big-number--neutral">
                {totalFindings}
              </div>
              <div className="scan-tile__subtitle">findings detected</div>
              {scanDiff && (totalNew > 0 || totalResolved > 0) && (
                <div
                  className={`scan-tile__diff ${
                    totalNew > totalResolved
                      ? "scan-tile__diff--positive"
                      : totalResolved > totalNew
                        ? "scan-tile__diff--negative"
                        : "scan-tile__diff--neutral"
                  }`}
                >
                  {totalNew > 0 && <span style={{ color: COLOR_CRITICAL }}>+{totalNew} new</span>}
                  {totalNew > 0 && totalResolved > 0 && " / "}
                  {totalResolved > 0 && (
                    <span style={{ color: STATUS_TINTS.success.text }}>
                      -{totalResolved} resolved
                    </span>
                  )}
                </div>
              )}
              {scanDiff && totalNew === 0 && totalResolved === 0 && (
                <div className="scan-tile__diff scan-tile__diff--neutral">no change</div>
              )}
            </div>
          </div>

          {/* Tile 3: Severity Breakdown */}
          <div className="scan-tile-wrapper">
            <h2 className="scan-section-title">Severity Breakdown</h2>
            <div className="scan-tile" style={{ marginTop: "8px" }}>
              <div className="severity-breakdown">
                <div className="severity-breakdown__header">
                  <span>Severity</span>
                  <span>Change</span>
                </div>
                {(
                  [
                    { key: "HIGH", label: "High", mod: "high" },
                    { key: "MEDIUM", label: "Medium", mod: "medium" },
                    { key: "LOW", label: "Low", mod: "low" },
                  ] as const
                ).map(({ key, label, mod }) => {
                  const count = summary[key];
                  const net = severityNet ? severityNet[key] : null;
                  return (
                    <div key={key} className="severity-row">
                      <div className="severity-row__left">
                        <span className={`severity-row__dot severity-row__dot--${mod}`} />
                        <span className={`severity-row__count severity-row__count--${mod}`}>
                          {count}
                        </span>
                        <span className="severity-row__label">{label}</span>
                      </div>
                      {net !== null && net !== 0 && (
                        <span
                          className={`severity-row__diff ${
                            net > 0
                              ? "severity-row__diff--positive"
                              : "severity-row__diff--negative"
                          }`}
                        >
                          {net > 0 ? `+${net}` : String(net)}
                        </span>
                      )}
                      {net !== null && net === 0 && (
                        <span className="severity-row__diff severity-row__diff--neutral">—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Tile 4: Performance Impact (conditional) */}
          {externalResourceCount > 0 && (
            <div className="scan-tile-wrapper">
              <h2 className="scan-section-title">Performance Impact</h2>
              <div className="scan-tile" style={{ marginTop: "8px" }}>
                <div
                  className={`scan-tile__big-number ${externalResourceCount > 3 ? "scan-tile__big-number--critical" : externalResourceCount > 1 ? "scan-tile__big-number--warning" : "scan-tile__big-number--neutral"}`}
                >
                  {externalResourceCount}
                </div>
                <div className="scan-tile__subtitle">external resources loading</div>
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "13px",
                    color: TEXT_SUBDUED,
                    textAlign: "center",
                  }}
                >
                  {scriptCount > 0 && (
                    <div>
                      {scriptCount} script{scriptCount !== 1 ? "s" : ""}
                    </div>
                  )}
                  {styleCount > 0 && (
                    <div>
                      {styleCount} stylesheet{styleCount !== 1 ? "s" : ""}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Findings detail table — only shown for completed scans */}
      {isCompleted &&
        (canViewDetails ? (
          <div style={{ marginTop: "32px" }}>
            <s-card>
              <s-stack direction="block" gap="base">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <h2 className="scan-section-title">Findings</h2>
                  {findings.length > 0 && (
                    <button
                      type="button"
                      onClick={async () => {
                        // Use authenticated fetch (App Bridge intercepts fetch in
                        // embedded apps and adds the session token automatically).
                        const res = await fetch(`/app/scans/${scan.id}/export?format=csv`);
                        if (!res.ok) {
                          shopify.toast.show("Export failed", { isError: true });
                          return;
                        }
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `ghost-code-scan-${scan.id}.csv`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "6px 12px",
                        borderRadius: "6px",
                        border: "1px solid #c9cccf",
                        background: BG_WHITE,
                        color: TEXT_SUBDUED,
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 20 20"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 17h12"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Export CSV
                    </button>
                  )}
                </div>
                {findings.some((f) => f.isTracker) && (
                  <s-banner tone="warning">
                    Findings marked TRACKING are from analytics or advertising scripts that may
                    still be collecting visitor data even though the app has been uninstalled.
                  </s-banner>
                )}
                {findings.length === 0 ? (
                  <s-paragraph>No ghost code detected in this scan.</s-paragraph>
                ) : (
                  <FindingsTable>
                    {findings.map((finding) => (
                      <FindingRow
                        key={finding.id}
                        finding={finding}
                        isNew={newFindingKeys.has(
                          `${finding.findingType}|${finding.filename}|${finding.severity}|${finding.appName ?? ""}`,
                        )}
                      />
                    ))}
                  </FindingsTable>
                )}
              </s-stack>
            </s-card>
          </div>
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

      {/* App Impact Map — groups findings by app to show which files each app touched */}
      {isCompleted && canViewDetails && appAttribution.size > 0 && (
        <div style={{ marginTop: "32px" }}>
          <s-card>
            <s-stack direction="block" gap="base">
              <h2 className="scan-section-title">App Impact Map</h2>
              <s-paragraph>
                Shows which theme files were modified by each app that left code behind.
              </s-paragraph>
              <style>{`
                .app-map-table {
                  width: 100%;
                  border-collapse: collapse;
                  font-size: 13px;
                }
                .app-map-table th,
                .app-map-table td {
                  border: 1px solid #e1e3e5;
                  padding: 8px 12px;
                  text-align: left;
                  vertical-align: top;
                }
                .app-map-table thead th {
                  background: #edeeef;
                  font-weight: 600;
                  white-space: nowrap;
                }
                .app-map-table tbody tr:nth-child(even) {
                  background: #fafbfb;
                }
              `}</style>
              <table className="app-map-table">
                <thead>
                  <tr>
                    <th>App</th>
                    <th>Findings</th>
                    <th>Types</th>
                    <th>Files Affected</th>
                  </tr>
                </thead>
                <tbody>
                  {[...appAttribution.entries()]
                    .sort((a, b) => b[1].count - a[1].count)
                    .map(([appName, data]) => (
                      <tr key={appName}>
                        <td style={{ fontWeight: 600 }}>{appName}</td>
                        <td style={{ textAlign: "center" }}>{data.count}</td>
                        <td>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                            {[...data.types].map((t) => (
                              <div key={t}>
                                <s-badge tone="neutral">{FINDING_TYPE_LABELS[t] ?? t}</s-badge>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          {[...data.files].map((f) => (
                            <div key={f}>
                              <code style={{ fontSize: "12px" }}>{f}</code>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </s-stack>
          </s-card>
        </div>
      )}
      {/* Unrecognized Scripts — merchant feedback loop for unknown external resources */}
      {isCompleted && canViewDetails && unknownScripts.length > 0 && (
        <div style={{ marginTop: "32px" }}>
          <s-card>
            <s-stack direction="block" gap="base">
              <h2 className="scan-section-title">Unrecognized Scripts</h2>
              <s-paragraph>
                These external scripts were found in your theme but could not be matched to a known
                app. If you recognize which app left these behind, let us know — it helps improve
                detection for everyone.
              </s-paragraph>
              <style>{`
                .unknown-scripts-table {
                  width: 100%;
                  border-collapse: collapse;
                  font-size: 13px;
                }
                .unknown-scripts-table th,
                .unknown-scripts-table td {
                  border: 1px solid #e1e3e5;
                  padding: 8px 12px;
                  text-align: left;
                  vertical-align: top;
                }
                .unknown-scripts-table thead th {
                  background: #edeeef;
                  font-weight: 600;
                }
                .unknown-scripts-table tbody tr:nth-child(even) {
                  background: #fafbfb;
                }
              `}</style>
              <table className="unknown-scripts-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>File</th>
                    <th>URL</th>
                    <th>Which app left this?</th>
                  </tr>
                </thead>
                <tbody>
                  {unknownScripts.map((script) => (
                    <UnknownScriptRow key={script.id} script={script} />
                  ))}
                </tbody>
              </table>
            </s-stack>
          </s-card>
        </div>
      )}
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
