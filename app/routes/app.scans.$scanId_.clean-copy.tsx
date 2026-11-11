/**
 * Clean copy, step 1 (gc-tib slice 5): pick the leftover code to remove and
 * confirm the apps are uninstalled. Submitting makes an unpublished copy of the
 * live theme (the worker removes the selected code from the copy only) and
 * sends the merchant to the status page. The live theme is never changed and
 * never published by us (spike D2).
 *
 * DARK: while CLEAN_COPY_ENABLED is off, and for any plan but Professional, the
 * loader redirects back to the scan page.
 *
 * The loader reads the affected files from the MAIN theme only to show the
 * exact code that would be removed (`spanText`). It returns that text and
 * nothing else of the file, and only when the file still matches the scan.
 */
import { createHash } from "node:crypto";

import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  data,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";

import { CleanCopyRunLines } from "../components/CleanCopyRunLines";
import { readChecked } from "../components/polaris-events";
import {
  type CleanCopyCandidate,
  CANDIDATE_BLOCK_REASONS,
  type CandidateBlockReason,
  type CandidateGroup,
  candidateBlockCopy,
  CLEAN_COPY_SCOPE,
  cleanCopyRunPath,
  type CleanCopyRunLine,
  findingRefusalCopy,
  groupCandidatesByApp,
  runRefusalCopy,
} from "../lib/clean-copy-view";
import { PLANS } from "../lib/plans";
import { FIXABLE_FINDING_TYPES } from "../lib/removal-span";
import { getFindingsForScan } from "../models/finding.server";
import { loadCleanCopyRunLines } from "../models/fix-run.server";
import { getIgnoredFindingsForShop } from "../models/ignored-finding.server";
import { getScanManifest } from "../models/scan-manifest.server";
import { getScanById } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import { parseLiveAppHooks } from "../services/app-removal.server";
import { createCleanCopyAdmin, MAX_FILES_PER_REQUEST } from "../services/clean-copy-admin.server";
import {
  checkCleanCopyFreshness,
  findingBlockReason,
  MAX_SELECTED_FINDINGS,
  requestCleanCopy,
} from "../services/clean-copy.server";
import { isCleanCopyEnabled } from "../services/soft-launch-flags.server";
import { authenticate } from "../shopify.server";
import {
  BORDER_DEFAULT,
  BG_SURFACE,
  groundStyle,
  hairline,
  TEXT_SUBDUED,
  textSubdued,
} from "../styles/shared";

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const MAX_FIELD_CHARS = 200;

const scanPath = (scanId: string) => `/app/scans/${encodeURIComponent(scanId)}`;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type CleanCopySelectData = {
  scanId: string;
  groups: CandidateGroup[];
  hasWriteScope: boolean;
  /** A refusal known before the merchant selects anything; the page explains it instead of a button. */
  refusal: string | null;
  /** Files with removable code beyond the per-copy file limit (not shown). */
  omittedFiles: number;
  /** The per-copy file limit, for the omitted-files note. */
  fileLimit: number;
  /** Links back to recent runs' result pages (gc-tib.20). */
  runLines?: CleanCopyRunLine[];
};

export const loader = async ({
  request,
  params,
}: LoaderFunctionArgs): Promise<CleanCopySelectData | Response> => {
  const { admin, session } = await authenticate.admin(request);
  const { scanId } = params;
  if (!scanId) throw new Response("Scan ID is required", { status: 400 });

  const shop = await getShopMetadata(session.shop);
  if (!shop) throw new Response("Not found", { status: 404 });

  // Dark, Professional only, and only the shop's own scan; otherwise back to the scan page.
  if (!isCleanCopyEnabled() || shop.plan !== PLANS.PROFESSIONAL) {
    return redirect(scanPath(scanId));
  }
  const scan = await getScanById(scanId, { includeFindings: false });
  if (!scan || scan.shopId !== shop.id) return redirect(scanPath(scanId));
  const runLines = await loadCleanCopyRunLines(shop.id);

  const cleanAdmin = createCleanCopyAdmin(admin);
  // Read live, not from the session (audit M-h): a grant or revoke since the
  // session was stored must count. A failed read asks for the scope again.
  const scopes = await cleanAdmin.getGrantedScopes();
  const hasWriteScope = scopes.ok && scopes.value.includes(CLEAN_COPY_SCOPE);
  const refused = (refusal: string): CleanCopySelectData => ({
    scanId: scan.id,
    groups: [],
    hasWriteScope,
    refusal,
    omittedFiles: 0,
    fileLimit: MAX_FILES_PER_REQUEST,
    runLines,
  });

  // The service's own freshness check (audit M-i): explain a stale scan, a
  // changed or Canvas theme instead of offering a button that will fail.
  const fresh = await checkCleanCopyFreshness({
    shopId: shop.id,
    lastThemePublishAt: shop.lastThemePublishAt,
    scan,
    admin: cleanAdmin,
  });
  if (!fresh.ok) return refused(fresh.reason);
  const main = fresh.main;
  const manifest = await getScanManifest(scan.id);
  if (!manifest) return refused("MANIFEST_MISSING");
  const md5ByPath = new Map(manifest.entries.map((e) => [e[0], e[1]] as const));
  const embedApps = parseLiveAppHooks(scan.liveAppHooks)?.embed ?? null;
  if (embedApps === null) return refused("EMBED_STATUS_UNKNOWN");

  const fixable = new Set<string>(FIXABLE_FINDING_TYPES);
  const [allFindings, ignores] = await Promise.all([
    getFindingsForScan(scan.id),
    getIgnoredFindingsForShop(shop.id),
  ]);
  const findings = allFindings.filter((f) => fixable.has(f.findingType));

  // Reasons known without reading a file, in the service's order.
  type Draft = { finding: (typeof findings)[number]; blocked: CandidateBlockReason | null };
  // The service's own rule (gc-tib.10). `findings` are fixable types only, so
  // NOT_FIXABLE_TYPE can't come back.
  const drafts: Draft[] = findings.map((finding) => {
    const reason = findingBlockReason(finding, ignores, embedApps);
    if (reason !== null && !(CANDIDATE_BLOCK_REASONS as readonly string[]).includes(reason)) {
      throw new Error(`clean copy: no page copy for block reason ${reason}`);
    }
    return { finding, blocked: reason as CandidateBlockReason | null };
  });

  // Read the affected MAIN files once (at most MAX_FILES_PER_REQUEST).
  const filenames = [...new Set(drafts.filter((d) => !d.blocked).map((d) => d.finding.filename))]
    .sort()
    .slice(0, MAX_FILES_PER_REQUEST);
  const shown = new Set(filenames);
  const omittedFiles = new Set(
    drafts
      .filter((d) => !d.blocked && !shown.has(d.finding.filename))
      .map((d) => d.finding.filename),
  ).size;

  const contentByFile = new Map<string, string | null>();
  if (filenames.length > 0) {
    const filesRes = await cleanAdmin.readFiles(main.id, filenames);
    if (!filesRes.ok) {
      return refused(filesRes.error === "ACCESS_DENIED" ? "ACCESS_DENIED" : "ADMIN_UNAVAILABLE");
    }
    for (const file of filesRes.value) contentByFile.set(file.filename, file.content);
  }

  const candidates: CleanCopyCandidate[] = [];
  for (const { finding, blocked } of drafts) {
    const base = {
      findingId: finding.id,
      findingType: finding.findingType,
      filename: finding.filename,
      lineNumber: finding.lineNumber,
      appName: finding.appName ?? null,
    };
    if (blocked) {
      candidates.push({ ...base, spanText: null, blocked });
      continue;
    }
    if (!shown.has(finding.filename)) continue;
    // The file must still be exactly what the scan saw, and the span still the
    // same text; otherwise the removal would hit different code.
    const content = contentByFile.get(finding.filename) ?? null;
    const { spanStart, spanEnd, spanSha256 } = finding;
    let spanText: string | null = null;
    if (
      content !== null &&
      spanStart !== null &&
      spanEnd !== null &&
      spanStart >= 0 &&
      spanStart < spanEnd &&
      spanEnd <= content.length &&
      md5ByPath.get(finding.filename) === md5(content)
    ) {
      const text = content.slice(spanStart, spanEnd);
      if (sha256(text) === spanSha256) spanText = text;
    }
    candidates.push(
      spanText === null
        ? { ...base, spanText: null, blocked: "FILE_CHANGED" }
        : { ...base, spanText, blocked: null },
    );
  }

  return {
    scanId: scan.id,
    groups: groupCandidatesByApp(candidates),
    hasWriteScope,
    refusal: null,
    omittedFiles,
    fileLimit: MAX_FILES_PER_REQUEST,
    runLines,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export type CleanCopySelectActionData = {
  refusal: string;
  findings: Array<{ findingId: string; reason: string }>;
};

/** Strings only, de-duplicated, bounded. Null when any value is not a string. */
function stringValues(form: FormData, key: string): string[] | null {
  const out = new Set<string>();
  for (const value of form.getAll(key)) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_FIELD_CHARS) return null;
    out.add(trimmed);
    if (out.size > MAX_SELECTED_FINDINGS) break;
  }
  return [...out];
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { scanId } = params;
  if (!scanId) throw new Response("Scan ID is required", { status: 400 });

  const shop = await getShopMetadata(session.shop);
  if (!shop) throw new Response("Not found", { status: 404 });

  const reject = (refusal: string) =>
    data<CleanCopySelectActionData>({ refusal, findings: [] }, { status: 400 });

  const form = await request.formData();
  const findingIds = stringValues(form, "findingIds");
  const confirmedApps = stringValues(form, "confirmedApps");
  if (findingIds === null || confirmedApps === null) return reject("FINDINGS_REFUSED");
  if (findingIds.length === 0) return reject("EMPTY_SELECTION");
  if (findingIds.length > MAX_SELECTED_FINDINGS || confirmedApps.length > MAX_SELECTED_FINDINGS) {
    return reject("TOO_MANY_FINDINGS");
  }

  const cleanAdmin = createCleanCopyAdmin(admin);
  const scopes = await cleanAdmin.getGrantedScopes();
  if (!scopes.ok) {
    return reject(scopes.error === "ACCESS_DENIED" ? "ACCESS_DENIED" : "ADMIN_UNAVAILABLE");
  }
  const result = await requestCleanCopy({
    shopId: shop.id,
    scanId,
    findingIds,
    confirmedApps,
    grantedScopes: scopes.value,
    admin: cleanAdmin,
  });
  if (result.ok) return redirect(cleanCopyRunPath(result.runId));
  if (result.reason === "RUN_ACTIVE") return redirect(cleanCopyRunPath(result.activeRunId));
  return {
    refusal: result.reason,
    findings: "findings" in result && result.findings ? result.findings : [],
  } satisfies CleanCopySelectActionData;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CLEAN_COPY_HEADING = "Make a clean copy";
export const CLEAN_COPY_INTRO =
  "We make an unpublished copy of your live theme and remove only the leftover code you select from the copy. You preview the copy and publish it yourself. Your live theme is never changed.";
export const CLEAN_COPY_NOTHING_TO_SELECT =
  "None of the leftover code in this scan can be removed in a clean copy.";
export const CLEAN_COPY_SUBMIT = "Make a clean copy";
export const CLEAN_COPY_ALLOW_SCOPE = "Allow theme changes";
export const CLEAN_COPY_SCOPE_DECLINED =
  "GhostCode needs permission to change themes to make a clean copy. Nothing was changed.";
export const CLEAN_COPY_SCOPE_UNAVAILABLE =
  "We couldn't open the permission request. Reload the page and try again.";

export function omittedFilesNotice(omittedFiles: number, fileLimit: number): string {
  return `One clean copy covers up to ${fileLimit} files, so we're showing the first ${fileLimit}. ${omittedFiles} more ${omittedFiles === 1 ? "file has" : "files have"} leftover code. Make this copy, then run a new scan to get the rest.`;
}

/** Apps with at least one selected candidate; each needs the uninstalled confirmation. */
export function appsNeedingConfirmation(
  groups: readonly CandidateGroup[],
  selected: ReadonlySet<string>,
): string[] {
  return groups
    .filter((g) => g.appName !== null && g.selectable.some((c) => selected.has(c.findingId)))
    .map((g) => g.appName as string);
}

/** The submit rule: something selected and every app with a selection confirmed. */
export function canSubmitSelection(
  groups: readonly CandidateGroup[],
  selected: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return false;
  return appsNeedingConfirmation(groups, selected).every((app) => confirmed.has(app));
}

declare const shopify:
  | {
      scopes?: {
        query: () => Promise<{ granted: string[] }>;
        request: (scopes: string[]) => Promise<unknown>;
      };
    }
  | undefined;

/** Ask App Bridge for write_themes. True when it is granted afterwards; the note says why not. */
async function requestWriteScope(): Promise<{ granted: boolean; note: string | null }> {
  if (typeof shopify === "undefined" || !shopify.scopes) {
    return { granted: false, note: CLEAN_COPY_SCOPE_UNAVAILABLE };
  }
  try {
    await shopify.scopes.request([CLEAN_COPY_SCOPE]);
    const { granted } = await shopify.scopes.query();
    return granted.includes(CLEAN_COPY_SCOPE)
      ? { granted: true, note: null }
      : { granted: false, note: CLEAN_COPY_SCOPE_DECLINED };
  } catch {
    return { granted: false, note: CLEAN_COPY_SCOPE_UNAVAILABLE };
  }
}

const codeBlockStyle: React.CSSProperties = {
  margin: "4px 0 0",
  padding: "8px 12px",
  background: BG_SURFACE,
  border: `1px solid ${BORDER_DEFAULT}`,
  borderRadius: "8px",
  fontSize: "13px",
  lineHeight: "19px",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

function CandidateRow({
  candidate,
  checked,
  onToggle,
  note,
}: {
  candidate: CleanCopyCandidate;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  note: string | null;
}) {
  const label = `${candidate.filename}, line ${candidate.lineNumber}`;
  return (
    <div>
      <s-checkbox
        label={label}
        checked={checked ? true : undefined}
        onChange={(e: unknown) => onToggle(readChecked(e))}
      />
      {candidate.spanText !== null && <pre style={codeBlockStyle}>{candidate.spanText}</pre>}
      {note && <p style={{ ...textSubdued, margin: "4px 0 0" }}>{note}</p>}
    </div>
  );
}

function BlockedRow({ candidate, note }: { candidate: CleanCopyCandidate; note: string }) {
  return (
    <div style={{ opacity: 0.65 }}>
      <strong style={{ fontSize: "14px" }}>
        {candidate.filename}, line {candidate.lineNumber}
      </strong>
      <p style={{ ...textSubdued, margin: "2px 0 0" }}>{note}</p>
    </div>
  );
}

export default function CleanCopySelect() {
  const {
    scanId,
    groups,
    hasWriteScope,
    refusal,
    omittedFiles,
    fileLimit,
    runLines = [],
  } = useLoaderData<typeof loader>() as CleanCopySelectData;
  const actionData = useActionData<typeof action>() as CleanCopySelectActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [scopeNote, setScopeNote] = useState<string | null>(null);

  const submitting = navigation.state === "submitting";
  const canSubmit = canSubmitSelection(groups, selected, confirmed) && !submitting;
  const refusedFindings = new Map((actionData?.findings ?? []).map((f) => [f.findingId, f.reason]));
  const shownRefusal = actionData?.refusal ?? refusal;

  const toggle = (set: ReadonlySet<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  async function handleSubmit() {
    if (!canSubmit) return;
    setScopeNote(null);
    if (!hasWriteScope) {
      const res = await requestWriteScope();
      if (!res.granted) {
        setScopeNote(res.note);
        return;
      }
    }
    const form = new FormData();
    for (const id of selected) form.append("findingIds", id);
    for (const app of appsNeedingConfirmation(groups, selected)) form.append("confirmedApps", app);
    submit(form, { method: "post" });
  }

  const hasSelectable = groups.some((g) => g.selectable.length > 0);

  return (
    <s-page heading={CLEAN_COPY_HEADING}>
      <Link to={`/app/scans/${encodeURIComponent(scanId)}`} slot="primary-action">
        Back to scan
      </Link>
      <div style={hairline} />
      <div style={groundStyle}>
        <CleanCopyRunLines lines={runLines} />
        {shownRefusal && <s-banner tone="critical">{runRefusalCopy(shownRefusal)}</s-banner>}
        {scopeNote && <s-banner tone="warning">{scopeNote}</s-banner>}
        <p style={{ margin: 0, color: TEXT_SUBDUED, fontSize: "14px", lineHeight: "21px" }}>
          {CLEAN_COPY_INTRO}
        </p>
        {omittedFiles > 0 && (
          <s-banner tone="info">{omittedFilesNotice(omittedFiles, fileLimit)}</s-banner>
        )}
        {!refusal && groups.length === 0 && (
          <s-banner tone="info">{CLEAN_COPY_NOTHING_TO_SELECT}</s-banner>
        )}
        {groups.map((group) => {
          const appLabel = group.appName ?? "Unknown app";
          const hasSelection = group.selectable.some((c) => selected.has(c.findingId));
          return (
            <s-section key={group.appName ?? "unknown-app"} heading={appLabel}>
              <s-stack direction="block" gap="base">
                {group.appName !== null && group.selectable.length > 0 && (
                  <s-checkbox
                    label={`I've uninstalled ${group.appName}`}
                    checked={confirmed.has(group.appName) ? true : undefined}
                    onChange={(e: unknown) =>
                      setConfirmed((prev) => toggle(prev, group.appName as string, readChecked(e)))
                    }
                  />
                )}
                {group.appName !== null && hasSelection && !confirmed.has(group.appName) && (
                  <p style={{ ...textSubdued, margin: 0 }}>
                    {`Confirm you've uninstalled ${group.appName} to continue.`}
                  </p>
                )}
                {group.selectable.map((c) => (
                  <CandidateRow
                    key={c.findingId}
                    candidate={c}
                    checked={selected.has(c.findingId)}
                    onToggle={(on) => setSelected((prev) => toggle(prev, c.findingId, on))}
                    note={
                      refusedFindings.has(c.findingId)
                        ? findingRefusalCopy(refusedFindings.get(c.findingId) as string)
                        : null
                    }
                  />
                ))}
                {group.blocked.map((c) => (
                  <BlockedRow
                    key={c.findingId}
                    candidate={c}
                    note={candidateBlockCopy(c.blocked as CandidateBlockReason)}
                  />
                ))}
              </s-stack>
            </s-section>
          );
        })}
        {hasSelectable && (
          <div>
            <s-button
              variant="primary"
              disabled={canSubmit ? undefined : true}
              loading={submitting ? true : undefined}
              onClick={() => void handleSubmit()}
            >
              {hasWriteScope ? CLEAN_COPY_SUBMIT : CLEAN_COPY_ALLOW_SCOPE}
            </s-button>
          </div>
        )}
      </div>
    </s-page>
  );
}

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
