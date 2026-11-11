/**
 * Clean copy, step 2 (gc-tib slice 5): the status and result of one run.
 *
 * Polls while the run is active. When it finishes, the merchant gets a link to
 * preview the unpublished copy and one to the theme library, plus what was and
 * wasn't removed. We never publish the copy (spike D2).
 *
 * The loader returns run fields and item rows only. It never returns file
 * content, and the preview link only when the run's summary allows it (never
 * for a run flagged do-not-publish).
 */
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import {
  fixItemReasonCopy,
  liveThemeNotice,
  liveThemeState,
  type LiveThemeNotice,
  previewUrl,
  runSummary,
  type RunSummary,
} from "../lib/clean-copy-view";
import { buildThemeEditorUrl, storeHandleFromDomain } from "../lib/theme-editor-url";
import { useScanPolling } from "../lib/use-scan-polling";
import { getFindingsForScan } from "../models/finding.server";
import { getFixRunWithItems, isStaleActiveRun } from "../models/fix-run.server";
import { getShopMetadata } from "../models/shop.server";
import { createCleanCopyAdmin } from "../services/clean-copy-admin.server";
import { authenticate } from "../shopify.server";
import { groundStyle, hairline, textSubdued } from "../styles/shared";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type CleanCopyRunItem = {
  id: string;
  filename: string;
  findingType: string | null;
  status: string;
  reasonCode: string | null;
  /** From the scan's finding; null once the scan is gone or while the run is active. */
  lineNumber: number | null;
};

export type CleanCopyRunData = {
  run: {
    id: string;
    scanId: string;
    status: string;
    failureReason: string | null;
    doNotPublish: boolean;
    copyThemeName: string | null;
    hasCopy: boolean;
  };
  summary: RunSummary;
  /** Stale-copy warning or "you published it" note (spike §3); null when neither. */
  liveTheme: LiveThemeNotice;
  items: CleanCopyRunItem[];
  /** Null unless the summary allows a preview. */
  previewUrl: string | null;
  themeLibraryUrl: string;
  /** Code editor link in the copy, per file with a removal. */
  editorUrls: Record<string, string>;
};

export const loader = async ({
  request,
  params,
}: LoaderFunctionArgs): Promise<CleanCopyRunData> => {
  const { admin, session } = await authenticate.admin(request);
  const { runId } = params;
  if (!runId) throw new Response("Run ID is required", { status: 400 });

  const shop = await getShopMetadata(session.shop);
  if (!shop) throw new Response("Not found", { status: 404 });

  const run = await getFixRunWithItems(runId);
  if (!run || run.shopId !== shop.id) throw new Response("Not found", { status: 404 });

  // An active run nobody has touched for the stale threshold was lost: show it
  // as stopped (the next request's sweep fails it for real, audit M-j).
  const stale = isStaleActiveRun(run);
  // COPY_MISSING: the copy was deleted, so never tell the merchant to delete it (r3).
  const hasCopy = run.copyThemeId !== null && run.failureReason !== "COPY_MISSING";
  const summaryInput = {
    status: stale ? "failed" : run.status,
    // A copy that is gone can't be published: no "don't publish" banner (r4).
    doNotPublish: run.doNotPublish && hasCopy,
    failureReason: stale ? "STALE" : run.failureReason,
    items: run.items,
    hasCopy,
  };
  let summary = runSummary(summaryInput);

  // Live-theme check (spike §3, audit H2, r2 gc-tib.13): for every finished run
  // that made a copy, so no banner claims the live theme is unchanged when the
  // merchant already published the copy. A failed read keeps the default copy
  // and never crashes. The stale-copy notice is only for a usable copy.
  let liveTheme: LiveThemeNotice = null;
  if (!summary.active && hasCopy && run.copyThemeId) {
    try {
      const main = await createCleanCopyAdmin(admin).getMainTheme();
      if (main.ok && main.value) {
        const liveState = liveThemeState({
          mainId: main.value.id,
          mainUpdatedAt: main.value.updatedAt,
          sourceThemeId: run.sourceThemeId,
          copyThemeId: run.copyThemeId,
          copyCreatedAt: run.copyCreatedAt,
        });
        summary = runSummary({ ...summaryInput, liveState });
        const finished = summaryInput.status === "completed" || summaryInput.status === "partial";
        if (finished && !run.doNotPublish) {
          liveTheme = liveThemeNotice(liveState);
        }
      }
    } catch {
      liveTheme = null;
    }
  }

  // Line numbers live on the scan's findings; only the finished list shows them.
  const lineByFinding = new Map<string, number>();
  if (!summary.active && run.items.length > 0) {
    const findings = await getFindingsForScan(run.scanId);
    for (const f of findings) lineByFinding.set(f.id, f.lineNumber);
  }

  const items: CleanCopyRunItem[] = run.items.map((i) => ({
    id: i.id,
    filename: i.filename,
    findingType: i.findingType,
    status: i.status,
    reasonCode: i.reasonCode,
    lineNumber: lineByFinding.get(i.findingId) ?? null,
  }));

  const editorUrls: Record<string, string> = {};
  if (summary.showPreview) {
    for (const item of items) {
      if (item.status !== "removed" || editorUrls[item.filename]) continue;
      const url = buildThemeEditorUrl(shop.domain, run.copyThemeId, item.filename);
      if (url) editorUrls[item.filename] = url;
    }
  }

  return {
    run: {
      id: run.id,
      scanId: run.scanId,
      status: run.status,
      failureReason: run.failureReason,
      doNotPublish: run.doNotPublish,
      // Only a copy that exists has a name worth showing (audit logic 12).
      copyThemeName: hasCopy ? run.copyThemeName : null,
      hasCopy,
    },
    summary,
    liveTheme,
    items,
    previewUrl: summary.showPreview ? previewUrl(shop.domain, run.copyThemeId) : null,
    themeLibraryUrl: `https://admin.shopify.com/store/${storeHandleFromDomain(shop.domain)}/themes`,
    editorUrls,
  };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CLEAN_COPY_PAGE_HEADING = "Clean copy";
export const CLEAN_COPY_FOOTER_NOTE =
  "The copy stays in your theme library until you delete it. It counts toward your store's theme limit.";
export const CLEAN_COPY_POLL_TIMEOUT =
  "This is taking longer than usual. Refresh the page to check on your clean copy.";

export function removedItemLabel(item: Pick<CleanCopyRunItem, "filename" | "lineNumber">): string {
  return item.lineNumber === null
    ? `Removed from ${item.filename}`
    : `Removed from ${item.filename}, line ${item.lineNumber}`;
}

function itemLocation(item: Pick<CleanCopyRunItem, "filename" | "lineNumber">): string {
  return item.lineNumber === null ? item.filename : `${item.filename}, line ${item.lineNumber}`;
}

export default function CleanCopyRun() {
  const {
    run,
    summary,
    liveTheme,
    items,
    previewUrl: preview,
    themeLibraryUrl,
    editorUrls,
  } = useLoaderData<typeof loader>() as CleanCopyRunData;
  // Reuse the scan page's capped revalidation poll while the run is active.
  const { pollingTimedOut } = useScanPolling(summary.active ? "IN_PROGRESS" : null);

  const removed = items.filter((i) => i.status === "removed");
  const notRemoved = items.filter((i) => i.status !== "removed");

  return (
    <s-page heading={CLEAN_COPY_PAGE_HEADING}>
      <Link to={`/app/scans/${encodeURIComponent(run.scanId)}`} slot="primary-action">
        Back to scan
      </Link>
      <div style={hairline} />
      <div style={groundStyle}>
        <s-banner tone={summary.tone} heading={summary.heading}>
          {summary.body}
        </s-banner>
        {liveTheme && <s-banner tone={liveTheme.tone}>{liveTheme.text}</s-banner>}
        {pollingTimedOut && <s-banner tone="warning">{CLEAN_COPY_POLL_TIMEOUT}</s-banner>}
        {(summary.showPreview || liveTheme) && (
          <s-stack direction="inline" gap="base">
            {summary.showPreview && preview && (
              <s-button variant="primary" href={preview} target="_blank">
                Preview clean copy
              </s-button>
            )}
            <s-button href={themeLibraryUrl} target="_top">
              Open theme library
            </s-button>
          </s-stack>
        )}
        {run.copyThemeName && !summary.active && (
          <p style={{ ...textSubdued, margin: 0 }}>Copy name: {run.copyThemeName}</p>
        )}
        {!summary.active && removed.length > 0 && !run.doNotPublish && (
          <s-section heading="Removed">
            <s-stack direction="block" gap="small">
              {removed.map((item) => (
                <div key={item.id}>
                  <span>{removedItemLabel(item)}</span>
                  {editorUrls[item.filename] && (
                    <>
                      {" "}
                      <s-link href={editorUrls[item.filename]} target="_top">
                        Open in code editor
                      </s-link>
                    </>
                  )}
                </div>
              ))}
            </s-stack>
          </s-section>
        )}
        {!summary.active && notRemoved.length > 0 && (
          <s-section heading="Not removed">
            <s-stack direction="block" gap="small">
              {notRemoved.map((item) => (
                <div key={item.id}>
                  <strong style={{ fontSize: "14px" }}>{itemLocation(item)}</strong>
                  <p style={{ ...textSubdued, margin: "2px 0 0" }}>
                    {fixItemReasonCopy(item.reasonCode ?? "UNKNOWN")}
                  </p>
                </div>
              ))}
            </s-stack>
          </s-section>
        )}
        {run.hasCopy && !summary.active && (
          <p style={{ ...textSubdued, margin: 0 }}>{CLEAN_COPY_FOOTER_NOTE}</p>
        )}
      </div>
    </s-page>
  );
}

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
