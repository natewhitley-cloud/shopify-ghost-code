/**
 * Resource route: /app/scans/:scanId/export?format=csv|json
 *
 * Returns a downloadable file containing the full findings for a completed scan.
 * Gated to paid plans only — free-tier merchants cannot view finding details
 * and therefore cannot export them.
 *
 * No UI component — this route only exports a loader. Callers link to it
 * directly with a download attribute on the anchor element.
 */

import type { LoaderFunctionArgs } from "react-router";

import { canViewFindingDetails } from "../lib/plan-gating.server";
import { getFindingsForScan } from "../models/finding.server";
import { getScanById } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Escape a single CSV field value:
 *   - Always wrap in double-quotes so commas and newlines inside values are safe.
 *   - Escape existing double-quote characters by doubling them ("").
 *   - Convert null/undefined to an empty string.
 */
function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '""';
  }
  const str = String(value);
  // Double up any internal double-quotes, then wrap the whole field.
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Serialize a single CSV row from an array of field values.
 */
function toCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields.map(escapeCsvField).join(",");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  // Step 1: Authenticate the session.
  const { session } = await authenticate.admin(request);
  const { scanId } = params;

  if (!scanId) {
    return new Response("Scan ID is required", { status: 400 });
  }

  // Step 2: Verify the shop exists.
  const shop = await getShopMetadata(session.shop);
  if (!shop) {
    return new Response("Not found", { status: 404 });
  }

  // Step 3: Check plan — only paid plans can export findings.
  if (!canViewFindingDetails(shop.plan)) {
    return new Response("Upgrade to Standard or Professional to export findings.", {
      status: 403,
    });
  }

  // Step 4: Load the scan and verify ownership.
  const scan = await getScanById(scanId, { includeFindings: false });
  if (!scan || scan.shopId !== shop.id) {
    return new Response("Not found", { status: 404 });
  }

  // Step 5: Determine export format from query params. Default to CSV.
  const url = new URL(request.url);
  const rawFormat = url.searchParams.get("format") ?? "csv";
  // Normalise to a supported format; any unrecognised value falls back to CSV.
  const format = rawFormat === "json" ? "json" : "csv";

  // Step 6: Fetch findings.
  const findings = await getFindingsForScan(scanId);

  // Step 7: Serialise and return the response.
  if (format === "json") {
    const body = JSON.stringify(
      {
        scanId: scan.id,
        themeName: scan.themeName,
        exportedAt: new Date().toISOString(),
        findings: findings.map((f) => ({
          severity: f.severity,
          type: f.findingType,
          file: f.filename,
          line: f.lineNumber,
          app: f.appName ?? null,
          codeSnippet: f.codeSnippet,
        })),
      },
      null,
      2,
    );

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="ghost-code-scan-${scan.id}.json"`,
      },
    });
  }

  // CSV format
  const headerRow = toCsvRow(["Severity", "Type", "File", "Line", "App", "Code Snippet"]);
  const dataRows = findings.map((f) =>
    toCsvRow([f.severity, f.findingType, f.filename, f.lineNumber, f.appName, f.codeSnippet]),
  );
  const csvBody = [headerRow, ...dataRows].join("\r\n");

  return new Response(csvBody, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ghost-code-scan-${scan.id}.csv"`,
    },
  });
};
