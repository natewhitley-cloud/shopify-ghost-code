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
 * Free trial (gc-tib.22): the loader reads the subscription live; during the
 * trial the page shows "N of 5 used" and won't submit more than the rest.
 *
 * The loader reads the affected files from the MAIN theme only to show the
 * exact code that would be removed (`spanText`). It returns that text and
 * nothing else of the file, and only when the file still matches the scan.
 */
import { createHash } from "node:crypto";

import { useRef, useState } from "react";
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
  appPiecesSummary,
  appSelectionState,
  type CleanCopyCandidate,
  CANDIDATE_BLOCK_REASONS,
  type CandidateBlockReason,
  type CandidateGroup,
  candidateBlockCopy,
  CLEAN_COPY_SCOPE,
  cleanCopyRunPath,
  type CleanCopyRunLine,
  consentLabel,
  type CleanCopyTrialView,
  findingRefusalCopy,
  groupCandidatesByApp,
  initialSelection,
  MAX_SELECTED_FINDINGS,
  runRefusalCopy,
  selectionHeading,
  toggleApp,
  trialNotice,
  trialOverSelectionNote,
  trialRemaining,
} from "../lib/clean-copy-view";
import { PLANS } from "../lib/plans";
import { FIXABLE_FINDING_TYPES, nonCodeRanges, removalSpanFor } from "../lib/removal-span";
import { getFindingsForScan } from "../models/finding.server";
import { countTrialRemovals, loadCleanCopyRunLines } from "../models/fix-run.server";
import { getIgnoredFindingsForShop } from "../models/ignored-finding.server";
import { getScanManifest } from "../models/scan-manifest.server";
import { getScanById } from "../models/scan.server";
import { getShopMetadata } from "../models/shop.server";
import { parseLiveAppHooks } from "../services/app-removal.server";
import { createCleanCopyAdmin, MAX_FILES_PER_REQUEST } from "../services/clean-copy-admin.server";
import {
  checkCleanCopyFreshness,
  cleanCopyTrial,
  offerableCleanCopyFiles,
  requestCleanCopy,
  TRIAL_CLEAN_COPY_LIMIT,
} from "../services/clean-copy.server";
import { isCleanCopyEnabled } from "../services/soft-launch-flags.server";
import { authenticate } from "../shopify.server";
import {
  ACCENT_BORDER,
  ACCENT_FILL,
  BG_HOVER,
  BORDER_DEFAULT,
  BG_SURFACE,
  COLOR_INFO,
  groundStyle,
  hairline,
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
  /** Set while the shop is in its free trial (gc-tib.22). */
  trial?: CleanCopyTrialView | null;
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
  if (!isCleanCopyEnabled(shop.domain) || shop.plan !== PLANS.PROFESSIONAL) {
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
    trial: null,
  });

  // gc-tib.22: read live; an unreadable subscription refuses (fail closed).
  const trialRes = await cleanCopyTrial(cleanAdmin);
  if (!trialRes.ok) return refused(trialRes.reason);
  const trial: CleanCopyTrialView | null =
    trialRes.trial === null
      ? null
      : {
          used: await countTrialRemovals(shop.id),
          limit: TRIAL_CLEAN_COPY_LIMIT,
          endsAt: trialRes.trial.endsAt.toISOString(),
        };

  // The service's own freshness check (audit M-i): explain a stale scan, a
  // changed or Canvas theme instead of offering a button that will fail.
  const fresh = await checkCleanCopyFreshness({
    shopId: shop.id,
    lastThemePublishAt: shop.lastThemePublishAt,
    scan,
    admin: cleanAdmin,
  });
  if (!fresh.ok) return { ...refused(fresh.reason), trial };
  const main = fresh.main;
  const manifest = await getScanManifest(scan.id);
  if (!manifest) return { ...refused("MANIFEST_MISSING"), trial };
  const md5ByPath = new Map(manifest.entries.map((e) => [e[0], e[1]] as const));
  const embedApps = parseLiveAppHooks(scan.liveAppHooks)?.embed ?? null;
  if (embedApps === null) return { ...refused("EMBED_STATUS_UNKNOWN"), trial };

  const fixable = new Set<string>(FIXABLE_FINDING_TYPES);
  const [allFindings, ignores] = await Promise.all([
    getFindingsForScan(scan.id),
    getIgnoredFindingsForShop(shop.id),
  ]);
  const findings = allFindings.filter((f) => fixable.has(f.findingType));

  // Reasons known without reading a file, and the files shown: the service's
  // own steps, shared with the scan page's count (gc-tib.10, gc-tib.21). The
  // findings here are fixable types only, so NOT_FIXABLE_TYPE can't come back.
  const offer = offerableCleanCopyFiles(findings, ignores, embedApps);
  type Draft = { finding: (typeof findings)[number]; blocked: CandidateBlockReason | null };
  const drafts: Draft[] = offer.drafts.map(({ finding, blocked }) => {
    if (blocked !== null && !(CANDIDATE_BLOCK_REASONS as readonly string[]).includes(blocked)) {
      throw new Error(`clean copy: no page copy for block reason ${blocked}`);
    }
    return { finding, blocked: blocked as CandidateBlockReason | null };
  });

  // Read the affected MAIN files once (at most MAX_FILES_PER_REQUEST).
  const filenames = offer.shownFiles;
  const shown = new Set(filenames);
  const omittedFiles = offer.omittedFiles;

  const contentByFile = new Map<string, string | null>();
  if (filenames.length > 0) {
    const filesRes = await cleanAdmin.readFiles(main.id, filenames);
    if (!filesRes.ok) {
      return {
        ...refused(filesRes.error === "ACCESS_DENIED" ? "ACCESS_DENIED" : "ADMIN_UNAVAILABLE"),
        trial,
      };
    }
    for (const file of filesRes.value) contentByFile.set(file.filename, file.content);
  }

  // gc-img6: re-run today's span rules on the live text, exactly as the
  // worker will (removalSpanFor on the file's non-code ranges, built once per
  // file), so a span stored by an older scan under older rules is not offered.
  const rangesByFile = new Map<string, Array<[number, number]> | null>();
  const passesSpanRules = (
    findingType: string,
    filename: string,
    content: string,
    start: number,
    end: number,
  ): boolean => {
    try {
      if (!rangesByFile.has(filename)) rangesByFile.set(filename, nonCodeRanges(content));
      const ranges = rangesByFile.get(filename);
      if (!ranges) return false;
      const located = removalSpanFor(findingType, content, start, ranges);
      return located.ok && located.span.start === start && located.span.end === end;
    } catch {
      // A throw refuses this file, like the worker's per-file check.
      rangesByFile.set(filename, null);
      return false;
    }
  };

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
    if (spanText === null) {
      candidates.push({ ...base, spanText: null, blocked: "FILE_CHANGED" });
    } else if (
      !passesSpanRules(
        finding.findingType,
        finding.filename,
        content as string,
        spanStart!,
        spanEnd!,
      )
    ) {
      candidates.push({ ...base, spanText: null, blocked: "NEEDS_NEW_SCAN" });
    } else {
      candidates.push({ ...base, spanText, blocked: null });
    }
  }

  return {
    scanId: scan.id,
    groups: groupCandidatesByApp(candidates),
    hasWriteScope,
    refusal: null,
    omittedFiles,
    fileLimit: MAX_FILES_PER_REQUEST,
    runLines,
    trial,
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
  // Before any Admin call (gc-g496): a shop without the flag costs nothing.
  if (!isCleanCopyEnabled(shop.domain)) return reject("FLAG_OFF");

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
export const SCAN_BREADCRUMB = "Scan results";
export const CONSENT_DETAILS = "Removing code for an app you still use can break it.";
export const SCOPE_PROMPT_NOTE =
  "The first time, Shopify asks you to allow theme changes. We start right after.";
export const SHOW_WHATS_REMOVED = "Show what's removed";
export const SHOW_WHY_NOT = "Show why";
export const APP_NOTHING_REMOVABLE = "Nothing from this app can be removed in a clean copy.";
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

/**
 * The apps the merchant has confirmed for THIS selection: only the ones named
 * when they ticked the line. An app selected after the tick is unconfirmed
 * until they tick again (audit r1 M5).
 */
export function confirmedAppsFor(
  appsToConfirm: readonly string[],
  consentedApps: ReadonlySet<string>,
): Set<string> {
  return new Set(appsToConfirm.filter((app) => consentedApps.has(app)));
}

/** The selection limited to what the page can still offer (after a reload; audit r1 L10). */
export function liveSelection(
  groups: readonly CandidateGroup[],
  selected: ReadonlySet<string>,
): Set<string> {
  const offered = new Set(groups.flatMap((g) => g.selectable.map((c) => c.findingId)));
  return new Set([...selected].filter((id) => offered.has(id)));
}

/**
 * The submit rule: something selected, no more than the trial still allows
 * (gc-tib.22), and every app with a selection confirmed.
 */
export function canSubmitSelection(
  groups: readonly CandidateGroup[],
  selected: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
  remaining: number = Number.POSITIVE_INFINITY,
): boolean {
  if (selected.size === 0 || selected.size > remaining) return false;
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

/** One removable piece inside an app's "Show what's removed" (untick to leave it out). */
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

const actionCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: "12px",
  padding: "22px 24px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  border: `1px solid ${ACCENT_BORDER}`,
  borderLeft: `6px solid ${ACCENT_FILL}`,
  display: "flex",
  flexDirection: "column",
  gap: "14px",
};

const appListStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: "12px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  overflow: "hidden",
};

const appRowStyle: React.CSSProperties = {
  padding: "14px 20px",
  borderBottom: `1px solid ${BG_HOVER}`,
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

/** One collapsed row per app: tick to include all its pieces, open to see (or untick) each one. */
function AppRow({
  group,
  selected,
  onToggleApp,
  onTogglePiece,
  refusedFindings,
}: {
  group: CandidateGroup;
  selected: ReadonlySet<string>;
  onToggleApp: (on: boolean) => void;
  onTogglePiece: (findingId: string, on: boolean) => void;
  refusedFindings: ReadonlyMap<string, string>;
}) {
  const appLabel = group.appName ?? "Unknown app";
  const state = appSelectionState(group, selected);
  const summary = appPiecesSummary(group);
  const removable = group.selectable.length;
  return (
    <div style={appRowStyle}>
      {removable > 0 ? (
        <s-checkbox
          label={`${appLabel} · ${removable} ${removable === 1 ? "piece" : "pieces"}`}
          details={summary}
          checked={state === "all" ? true : undefined}
          indeterminate={state === "some" ? true : undefined}
          onChange={(e: unknown) => onToggleApp(readChecked(e))}
        />
      ) : (
        <div>
          <strong style={{ fontSize: "14px" }}>{appLabel}</strong>
          <p style={{ ...textSubdued, margin: "2px 0 0" }}>{APP_NOTHING_REMOVABLE}</p>
        </div>
      )}
      <details>
        <summary style={{ cursor: "pointer", color: COLOR_INFO, fontSize: "13px" }}>
          {removable > 0 ? SHOW_WHATS_REMOVED : SHOW_WHY_NOT}
        </summary>
        <s-stack direction="block" gap="base">
          {group.selectable.map((c) => (
            <CandidateRow
              key={c.findingId}
              candidate={c}
              checked={selected.has(c.findingId)}
              onToggle={(on) => onTogglePiece(c.findingId, on)}
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
      </details>
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
    trial = null,
  } = useLoaderData<typeof loader>() as CleanCopySelectData;
  const actionData = useActionData<typeof action>() as CleanCopySelectActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const remaining = trialRemaining(trial);
  // gc-np1d.1: everything removable starts selected; the merchant unticks what to
  // keep. Never more than the server accepts in one request (audit r1 L9).
  const cap = Math.min(remaining, MAX_SELECTED_FINDINGS);
  const [picked, setSelected] = useState<ReadonlySet<string>>(() => initialSelection(groups, cap));
  const selected = liveSelection(groups, picked);
  const [consentedApps, setConsentedApps] = useState<ReadonlySet<string>>(() => new Set());
  const [scopeNote, setScopeNote] = useState<string | null>(null);
  // One submit at a time, including while Shopify's permission dialog is open (audit r1 L11).
  const inFlight = useRef(false);

  const submitting = navigation.state === "submitting";
  const overTrial = selected.size > remaining;
  const appsToConfirm = appsNeedingConfirmation(groups, selected);
  const confirmed = confirmedAppsFor(appsToConfirm, consentedApps);
  const consented = appsToConfirm.length > 0 && confirmed.size === appsToConfirm.length;
  const canSubmit = canSubmitSelection(groups, selected, confirmed, remaining) && !submitting;
  const trialBanner = trial ? trialNotice(trial) : null;
  const refusedFindings = new Map((actionData?.findings ?? []).map((f) => [f.findingId, f.reason]));
  const shownRefusal = actionData?.refusal ?? refusal;

  const togglePiece = (findingId: string, on: boolean) =>
    setSelected((prev) => {
      const next = liveSelection(groups, prev);
      if (!on) next.delete(findingId);
      else if (next.size < cap) next.add(findingId);
      return next;
    });

  async function handleSubmit() {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    try {
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
      for (const app of confirmed) form.append("confirmedApps", app);
      submit(form, { method: "post" });
    } finally {
      inFlight.current = false;
    }
  }

  const hasSelectable = groups.some((g) => g.selectable.length > 0);

  return (
    <s-page heading={CLEAN_COPY_HEADING}>
      <Link to={scanPath(scanId)} slot="breadcrumb-actions">
        {SCAN_BREADCRUMB}
      </Link>
      <div style={hairline} />
      <div style={groundStyle}>
        <CleanCopyRunLines lines={runLines} />
        {shownRefusal && <s-banner tone="critical">{runRefusalCopy(shownRefusal)}</s-banner>}
        {trialBanner && <s-banner tone={trialBanner.tone}>{trialBanner.text}</s-banner>}
        {!refusal && groups.length === 0 && (
          <s-banner tone="info">{CLEAN_COPY_NOTHING_TO_SELECT}</s-banner>
        )}
        {hasSelectable && (
          <div style={actionCardStyle}>
            <h2 style={{ margin: 0, fontSize: "20px", lineHeight: "28px", fontWeight: 650 }}>
              {selectionHeading(selected.size)}
            </h2>
            <p style={{ margin: 0, fontSize: "14px", lineHeight: "21px", maxWidth: "760px" }}>
              {CLEAN_COPY_INTRO}
            </p>
            {appsToConfirm.length > 0 && (
              <s-checkbox
                // A new set of apps is a new question: remount so the box never
                // looks ticked for apps it didn't name (audit r2 M2).
                key={appsToConfirm.join("|")}
                label={consentLabel(appsToConfirm)}
                details={CONSENT_DETAILS}
                checked={consented ? true : undefined}
                onChange={(e: unknown) =>
                  setConsentedApps(new Set(readChecked(e) ? appsToConfirm : []))
                }
              />
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
              <s-button
                variant="primary"
                disabled={canSubmit ? undefined : true}
                loading={submitting ? true : undefined}
                onClick={() => void handleSubmit()}
              >
                {CLEAN_COPY_SUBMIT}
              </s-button>
              {!hasWriteScope && <span style={textSubdued}>{SCOPE_PROMPT_NOTE}</span>}
            </div>
            {scopeNote && <s-banner tone="warning">{scopeNote}</s-banner>}
            {overTrial && remaining > 0 && (
              <p style={{ ...textSubdued, margin: 0 }}>{trialOverSelectionNote(remaining)}</p>
            )}
          </div>
        )}
        {omittedFiles > 0 && (
          <s-banner tone="info">{omittedFilesNotice(omittedFiles, fileLimit)}</s-banner>
        )}
        {groups.length > 0 && (
          <div style={appListStyle}>
            {groups.map((group) => (
              <AppRow
                key={group.appName ?? "unknown-app"}
                group={group}
                selected={selected}
                onToggleApp={(on) =>
                  setSelected((prev) => toggleApp(group, liveSelection(groups, prev), on, cap))
                }
                onTogglePiece={togglePiece}
                refusedFindings={refusedFindings}
              />
            ))}
          </div>
        )}
      </div>
    </s-page>
  );
}

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
