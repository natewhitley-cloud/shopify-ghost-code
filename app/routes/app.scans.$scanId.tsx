import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";

import { copyToClipboard } from "../lib/clipboard";
import { hasVisualImpact } from "../lib/finding-classification";
import { getFindingRemediation } from "../lib/finding-remediation";
import { formatDate, isSuccessfulScan, statusLabel, statusTone } from "../lib/format";
import type { ScanStatus } from "../lib/format";
import { computeHealthScore } from "../lib/health-score";
import type { HealthScoreResult } from "../lib/health-score";
import { canUseScanDiffing, canViewFindingDetails } from "../lib/plan-gating.server";
import {
  getAppAttributionForScan,
  getFindingsPageForScan,
  getFindingSummary,
  getHighestSeverityFinding,
} from "../models/finding.server";
import { getScanById } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import {
  findUnknownScriptForShop,
  getUnknownScriptsForScan,
  submitSignatureSuggestion,
} from "../models/unknown-script.server";
import { isTrackerApp } from "../services/app-lookup.server";
import type { ScanDiff } from "../services/scan-differ.server";
import { authenticate } from "../shopify.server";
import {
  BG_BADGE_SUCCESS,
  BG_HOVER,
  BG_SURFACE,
  BG_WHITE,
  BORDER_DEFAULT,
  BORDER_STRONG,
  COLOR_CRITICAL,
  COLOR_INFO,
  COLOR_WARNING,
  htmlTableCss,
  STATUS_TINTS,
  TEXT_DISABLED,
  TEXT_PRIMARY,
  TEXT_SUBDUED,
  tileStatusTintCss,
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

/**
 * Copy-to-clipboard button for a finding's full code snippet.
 *
 * Uses the iframe-safe copyToClipboard helper (async Clipboard API with an
 * execCommand fallback) and shows a brief "Copied" confirmation. Each button
 * owns its own confirmation state so rows are independent.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending reset timer on unmount to avoid setting state after the
  // row is gone (e.g. when paginating).
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (!ok) {
      shopify.toast.show("Copy failed. Select the code and copy manually.", { isError: true });
      return;
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label="Copy code snippet"
      style={{
        flexShrink: 0,
        padding: "2px 8px",
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: "4px",
        fontSize: "11px",
        background: copied ? BG_BADGE_SUCCESS : BG_SURFACE,
        color: copied ? STATUS_TINTS.success.text : TEXT_SUBDUED,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function FindingRow({ finding, isNew }: { finding: FindingLike; isNew?: boolean }) {
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
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
            <code style={{ fontSize: "12px", wordBreak: "break-word", flex: 1 }}>
              {finding.codeSnippet.length > 80
                ? `${finding.codeSnippet.slice(0, 80)}…`
                : finding.codeSnippet}
            </code>
            <CopyButton text={finding.codeSnippet} />
          </div>
          <div
            style={{
              fontSize: "12px",
              color: TEXT_SUBDUED,
              lineHeight: 1.4,
            }}
          >
            <strong style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>How to remove: </strong>
            {getFindingRemediation(finding.findingType)}
          </div>
        </div>
      </td>
    </tr>
  );
}

const FINDINGS_TABLE_STYLES = `
  ${htmlTableCss("findings-table")}
  .findings-table thead th {
    white-space: nowrap;
    position: sticky;
    top: 0;
    border-bottom: 2px solid ${BORDER_STRONG};
  }
  .findings-table tbody tr:hover {
    background: ${BG_HOVER};
  }
  .findings-table td:nth-child(1) { width: 80px; }
  .findings-table td:nth-child(2) { width: 100px; white-space: nowrap; }
  .findings-table td:nth-child(3) { width: 200px; }
  .findings-table td:nth-child(4) { width: 50px; text-align: center; }
  .findings-table td:nth-child(5) { width: 100px; }
  .findings-table td:nth-child(6) { max-width: 520px; }
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

/** Number of findings per page. */
const PAGE_SIZE = 50;

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

  // The scan is always fetched without inline findings. Findings are either
  // paginated (paid plan) or fetched as a single preview (free plan) via
  // separate queries below, keeping this query lightweight.
  const scan = await getScanById(scanId, { includeFindings: false });

  // Verify the scan exists and belongs to the authenticated shop.
  if (!scan || scan.shopId !== shop.id) {
    throw new Response("Not found", { status: 404 });
  }

  // Parse cursor from URL for findings pagination (paid plans only).
  const url = new URL(request.url);
  const findingsCursor = url.searchParams.get("cursor") || undefined;

  // Parallel queries — all independent of each other once `scan` is resolved.
  const [findingSummary, rawPreviewFinding, findingsPage, appAttributionData, unknownScripts] =
    await Promise.all([
      getFindingSummary(scanId),
      // Free-tier only: fetch a single preview finding (paid users get a page).
      canViewDetails ? Promise.resolve(null) : getHighestSeverityFinding(scanId),
      // Paid plan: paginated findings for the current page.
      // Free plan or non-completed scans: empty page (findings not shown).
      canViewDetails && isSuccessfulScan(scan.status)
        ? getFindingsPageForScan(scanId, { limit: PAGE_SIZE, cursor: findingsCursor })
        : Promise.resolve({ items: [], hasNextPage: false, nextCursor: null }),
      // App Impact Map data: lean attribution query (all scans, no pagination).
      // Only needed when the user can view details AND the scan succeeded.
      canViewDetails && isSuccessfulScan(scan.status)
        ? getAppAttributionForScan(scanId)
        : Promise.resolve([] as Awaited<ReturnType<typeof getAppAttributionForScan>>),
      // Unknown scripts: only for successful scans when user can view details.
      isSuccessfulScan(scan.status) && canViewDetails
        ? getUnknownScriptsForScan(scanId)
        : Promise.resolve([]),
    ]);

  // Compute health score for successful scans (COMPLETED or PARTIAL).
  let healthScore: HealthScoreResult | null = null;
  if (isSuccessfulScan(scan.status)) {
    healthScore = computeHealthScore(findingSummary.bySeverity);
  }

  // Enrich each finding on the current page with the tracker flag.
  const enrichedFindingsPage = findingsPage.items.map((f) => ({
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

  // Whether this shop+plan combination can trigger the diff resource route.
  // Exposed to the component so it knows whether to issue the useFetcher call.
  const canUseDiffing = isSuccessfulScan(scan.status) && canUseScanDiffing(shop.plan);

  return {
    scan: {
      id: scan.id,
      themeName: scan.themeName,
      status: scan.status,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      createdAt: scan.createdAt,
      findingCount: scan.findingCount,
      skippedFiles: scan.skippedFiles,
    },
    findings: enrichedFindingsPage,
    findingsPagination: {
      hasNextPage: findingsPage.hasNextPage,
      nextCursor: findingsPage.nextCursor,
    },
    previewFinding,
    findingSummary,
    canViewDetails,
    canUseDiffing,
    healthScore,
    unknownScripts,
    appAttributionData,
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
                border: `1px solid ${BORDER_STRONG}`,
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
                border: `1px solid ${BORDER_STRONG}`,
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
    findingsPagination,
    previewFinding,
    findingSummary,
    canViewDetails,
    canUseDiffing,
    healthScore,
    unknownScripts,
    appAttributionData,
  } = useLoaderData<typeof loader>();

  // Diff is loaded lazily via a resource route to avoid blocking the main page
  // render on the expensive full-findings load for two scans (PRF-2).
  const diffFetcher = useFetcher<{ scanDiff: ScanDiff | null }>();
  // Ref prevents the diff from being re-requested on subsequent renders
  // (e.g. after a poll revalidate while scan was still running).
  const diffLoadTriggered = useRef(false);

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

  // Load the diff once for completed scans on eligible plans.
  // Uses a resource route to avoid blocking the main page render on the
  // expensive full-findings load for two scans (PRF-2 — see .diff.tsx route).
  // The ref guard prevents re-loading on subsequent poll-triggered re-renders.
  const isCompleted = isSuccessfulScan(scan.status);
  useEffect(() => {
    if (!isCompleted || !canUseDiffing || diffLoadTriggered.current) return;
    diffLoadTriggered.current = true;
    diffFetcher.load(`/app/scans/${scan.id}/diff`);
    // diffFetcher is a stable object; isCompleted, canUseDiffing, scan.id
    // are the meaningful dependencies here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompleted, canUseDiffing, scan.id]);

  const status = scan.status as ScanStatus;
  const summary = findingSummary.bySeverity;

  const isFailed = scan.status === "FAILED";
  const isRunning = scan.status === "PENDING" || scan.status === "IN_PROGRESS";

  // Diff from the lazy resource route — null until the fetcher resolves.
  const scanDiff = diffFetcher.data?.scanDiff ?? null;

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

  // Performance impact counts derived from the findingSummary aggregate (covers
  // all findings, not just the current page). Previously computed by filtering
  // the full findings array; now derived from the summary to avoid sending the
  // full findings to the client.
  const scriptCount = findingSummary.byType.GHOST_SCRIPT;
  const styleCount = findingSummary.byType.GHOST_STYLE;
  const externalResourceCount = scriptCount + styleCount;

  // Build app attribution map from the pre-fetched lean attribution data
  // (appName, filename, findingType only — no codeSnippet/description).
  const appAttribution = new Map<
    string,
    { files: Set<string>; count: number; types: Set<string> }
  >();
  for (const f of appAttributionData) {
    if (!appAttribution.has(f.appName)) {
      appAttribution.set(f.appName, { files: new Set(), count: 0, types: new Set() });
    }
    const entry = appAttribution.get(f.appName)!;
    entry.files.add(f.filename);
    entry.count++;
    entry.types.add(f.findingType);
  }

  // Build a Set of fingerprints for new findings so we can tag rows in the table.
  // Available once the diff fetcher resolves; rows render without the badge until then.
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
          color: ${TEXT_SUBDUED};
          padding: 8px 0;
          flex-wrap: wrap;
        }
        .scan-status-bar__separator {
          color: ${BORDER_STRONG};
        }
        .scan-section-title {
          font-size: 18px;
          font-weight: 600;
          color: ${TEXT_PRIMARY};
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
          border: 1px solid ${BORDER_DEFAULT};
          background: ${BG_WHITE};
          flex: 1;
        }
        ${tileStatusTintCss({
          success: "scan-tile--health-success",
          warning: "scan-tile--health-warning",
          critical: "scan-tile--health-critical",
        })}
        .scan-tile__big-number {
          font-size: 48px;
          font-weight: 700;
          line-height: 1;
          letter-spacing: -2px;
        }
        .scan-tile__big-number--success { color: ${STATUS_TINTS.success.text}; }
        .scan-tile__big-number--warning { color: ${COLOR_WARNING}; }
        .scan-tile__big-number--critical { color: ${COLOR_CRITICAL}; }
        .scan-tile__big-number--neutral { color: ${TEXT_PRIMARY}; }
        .scan-tile__subtitle {
          font-size: 14px;
          color: ${TEXT_SUBDUED};
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
        .scan-tile__label--success { background: ${BG_BADGE_SUCCESS}; color: ${STATUS_TINTS.success.text}; }
        .scan-tile__label--warning { background: ${STATUS_TINTS.warning.border}; color: ${STATUS_TINTS.warning.text}; }
        .scan-tile__label--critical { background: ${STATUS_TINTS.critical.border}; color: ${COLOR_CRITICAL}; }
        .scan-tile__diff {
          font-size: 13px;
          margin-top: 8px;
        }
        .scan-tile__diff--positive { color: ${COLOR_CRITICAL}; }
        .scan-tile__diff--negative { color: ${STATUS_TINTS.success.text}; }
        .scan-tile__diff--neutral { color: ${TEXT_SUBDUED}; }
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
          border-bottom: 1px solid ${BORDER_DEFAULT};
          font-size: 11px;
          font-weight: 600;
          color: ${TEXT_DISABLED};
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
        .severity-row__count--high { color: ${COLOR_CRITICAL}; }
        .severity-row__count--medium { color: ${COLOR_WARNING}; }
        .severity-row__count--low { color: ${COLOR_INFO}; }
        .severity-row__label {
          font-size: 14px;
          font-weight: 500;
          color: ${TEXT_SUBDUED};
        }
        .severity-row__dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .severity-row__dot--high { background: ${COLOR_CRITICAL}; }
        .severity-row__dot--medium { background: ${COLOR_WARNING}; }
        .severity-row__dot--low { background: ${COLOR_INFO}; }
        .severity-row__diff {
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
        }
        .severity-row__diff--positive { color: ${COLOR_CRITICAL}; }
        .severity-row__diff--negative { color: ${STATUS_TINTS.success.text}; }
        .severity-row__diff--neutral { color: ${TEXT_DISABLED}; }
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

      {/* Oversized-file skip notice — these files were too large (>1 MB) to
          scan, so their findings are neither reported nor diffed (gc-06e.19). */}
      {isCompleted && scan.skippedFiles.length > 0 && (
        <div style={{ marginTop: "16px" }}>
          <s-banner tone="warning">
            {scan.skippedFiles.length} file{scan.skippedFiles.length !== 1 ? "s" : ""} skipped (over
            1 MB, not scanned): {scan.skippedFiles.join(", ")}. Findings in{" "}
            {scan.skippedFiles.length !== 1 ? "these files" : "this file"} are not included in this
            scan or its comparison.
          </s-banner>
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
                        border: `1px solid ${BORDER_STRONG}`,
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
                  <>
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
                    {findingsPagination.hasNextPage && (
                      <s-box padding-block-start="base">
                        <s-stack direction="inline" gap="base">
                          <Link
                            to={`/app/scans/${scan.id}?cursor=${findingsPagination.nextCursor}`}
                          >
                            Load More
                          </Link>
                        </s-stack>
                      </s-box>
                    )}
                  </>
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
                ${htmlTableCss("app-map-table")}
                .app-map-table thead th { white-space: nowrap; }
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
              <style>{`${htmlTableCss("unknown-scripts-table")}`}</style>
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
