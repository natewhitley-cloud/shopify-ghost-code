/**
 * Server-only PDF renderer for scan findings (gc-rrh.1).
 *
 * The `.server` suffix guarantees this module never bundles into the client.
 * It is purely presentational: the caller computes the health score and passes
 * findings in; this module does no DB access and no scoring. It sorts findings
 * by severity and renders a clean, branded, shareable report.
 */

import { Document, Page, View, Text, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

type Severity = "HIGH" | "MEDIUM" | "LOW";

type ReportFinding = {
  severity: Severity;
  findingType: string;
  filename: string;
  lineNumber: number;
  appName: string | null;
  description: string;
  codeSnippet: string;
};

export type ScanReportInput = {
  scan: { id: string; themeName: string; createdAt: Date | string };
  findings: ReportFinding[];
  healthScore: { score: number; label: string };
  exportedAt: string; // ISO
};

// Sort order: HIGH → MEDIUM → LOW.
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// Cap the number of finding cards rendered so a pathological scan cannot force a
// huge synchronous PDF render. The severity summary and health score still
// reflect ALL findings — only the rendered LIST is capped.
const MAX_PDF_FINDINGS = 250;

// Restrained slate/professional palette.
const HEADING = "#1f2933";
const SUBDUED = "#52606d";
const HAIRLINE = "#e4e7eb";
const WHITE = "#ffffff";

const styles = StyleSheet.create({
  page: {
    backgroundColor: WHITE,
    paddingVertical: 40,
    paddingHorizontal: 44,
    fontSize: 10,
    color: SUBDUED,
    fontFamily: "Helvetica",
  },
  title: {
    fontSize: 18,
    color: HEADING,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  metaLine: {
    fontSize: 10,
    color: SUBDUED,
    marginBottom: 2,
  },
  healthLine: {
    fontSize: 13,
    color: HEADING,
    fontFamily: "Helvetica-Bold",
    marginTop: 8,
  },
  summaryLine: {
    fontSize: 10,
    color: SUBDUED,
    marginTop: 4,
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
    marginTop: 14,
    marginBottom: 14,
  },
  finding: {
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
    paddingBottom: 10,
    marginBottom: 10,
  },
  findingHeader: {
    fontSize: 11,
    color: HEADING,
    fontFamily: "Helvetica-Bold",
    marginBottom: 3,
  },
  findingMeta: {
    fontSize: 9,
    color: SUBDUED,
    marginBottom: 3,
  },
  findingDescription: {
    fontSize: 10,
    color: HEADING,
    marginBottom: 4,
  },
  code: {
    fontFamily: "Courier",
    fontSize: 8,
    color: SUBDUED,
    backgroundColor: "#f5f7fa",
    padding: 5,
  },
  emptyState: {
    fontSize: 11,
    color: SUBDUED,
    marginTop: 20,
  },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 44,
    right: 44,
    fontSize: 8,
    color: SUBDUED,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
    paddingTop: 6,
  },
});

/** Format a Date (or ISO string) as a simple YYYY-MM-DD. */
function formatDate(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toISOString().slice(0, 10);
}

/** Humanize a findingType (the category) by replacing underscores with spaces. */
function humanizeType(findingType: string): string {
  return findingType.replace(/_/g, " ");
}

/** Truncate a code snippet to a readable length for the report. */
function truncateSnippet(snippet: string): string {
  const MAX = 200;
  return snippet.length > MAX ? `${snippet.slice(0, MAX)}…` : snippet;
}

function ScanReportDocument({ scan, findings, healthScore, exportedAt }: ScanReportInput) {
  // Sort a COPY — never rely on input order.
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) {
    counts[f.severity] += 1;
  }

  // Cap the rendered list; counts above already reflect the full set.
  const visible = sorted.slice(0, MAX_PDF_FINDINGS);
  const overflow = sorted.length - visible.length;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View>
          <Text style={styles.title}>Ghost Code — Scan Report</Text>
          <Text style={styles.metaLine}>Theme: {scan.themeName}</Text>
          <Text style={styles.metaLine}>Scan date: {formatDate(scan.createdAt)}</Text>
          <Text style={styles.healthLine}>
            Health Score: {healthScore.score}/100 — {healthScore.label}
          </Text>
          <Text style={styles.summaryLine}>
            {counts.HIGH} High · {counts.MEDIUM} Medium · {counts.LOW} Low
          </Text>
        </View>

        <View style={styles.divider} />

        {sorted.length === 0 ? (
          <Text style={styles.emptyState}>No findings — this theme is clean.</Text>
        ) : (
          visible.map((f, i) => (
            <View key={i} style={styles.finding} wrap={false}>
              <Text style={styles.findingHeader}>
                {f.severity} · {humanizeType(f.findingType)}
              </Text>
              <Text style={styles.findingMeta}>
                {f.filename}:{f.lineNumber} · App: {f.appName ?? "—"}
              </Text>
              <Text style={styles.findingDescription}>{f.description}</Text>
              <Text style={styles.code}>{truncateSnippet(f.codeSnippet)}</Text>
            </View>
          ))
        )}

        {overflow > 0 ? (
          <Text style={styles.summaryLine}>
            +{overflow} more findings — see full results in Ghost Code.
          </Text>
        ) : null}

        <Text style={styles.footer} fixed>
          Ghost Code · Scan {scan.id} · Exported {formatDate(exportedAt)}
        </Text>
      </Page>
    </Document>
  );
}

/**
 * Render a scan report to a PDF Buffer.
 */
export async function renderScanReportPdf(input: ScanReportInput): Promise<Buffer> {
  return renderToBuffer(<ScanReportDocument {...input} />);
}
