/**
 * Store speed (gc-wt3y): the weekly Google PageSpeed report for the homepage
 * and one product page, with the cost broken down by app. Professional only;
 * Free and Standard see a locked teaser with the plan upgrade button.
 *
 * DARK: while SPEED_REPORT_LIVE_ENABLED is off the loader and action 404
 * (the nav entry in app.tsx is hidden too).
 *
 * Client-safe imports only for the component: status/origin are plain strings
 * from app/lib/speed-report.ts (never Prisma enum values).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";

import { FormattedDate } from "../components/FormattedDate";
import { buildPricingPlansUrl, getPlanFeatures } from "../lib/billing.server";
import { PLANS } from "../lib/plans";
import {
  appCostHeadline,
  buildSpeedReportView,
  formatBytes,
  formatSeconds,
  formatSpeedDelta,
  NEEDS_PRODUCT_ACCESS_MESSAGE,
  NO_PRODUCT_MESSAGE,
  PASSWORD_PROTECTED_MESSAGE,
  runNowAvailableAt,
  SPEED_CAVEAT,
  SPEED_INTRO,
  SPEED_METRIC_LABELS,
  SPEED_PAGE_LABELS,
  SPEED_REPORT_STATUS,
  SPEED_TEASER_BODY,
  SPEED_TEASER_HEADING,
  speedFailureMessage,
  speedPageDelta,
  speedScoreTone,
} from "../lib/speed-report";
import type {
  SpeedCostRow,
  SpeedPageResult,
  SpeedReportSummaryView,
  SpeedReportView,
} from "../lib/speed-report";
import { upgradeCtaLabel } from "../lib/trial-cta";
import { recordUpgradeClick } from "../lib/upgrade-preview";
import { useScanPolling } from "../lib/use-scan-polling";
import { getShopMetadata } from "../models/shop.server";
import { getRecentSpeedReports, getSpeedReportRequestedAt } from "../models/speed-report.server";
import { recordNudgeStageOnce } from "../services/nudge-stage.server";
import { NUDGE_KEYS } from "../services/nudge-telemetry.server";
import { isSpeedReportLive } from "../services/speed-report-config.server";
import { requestSpeedReportRunNow } from "../services/speed-report.server";
import { getTrialEligibility } from "../services/trial-eligibility.server";
import { authenticate } from "../shopify.server";
import {
  COLOR_CRITICAL,
  COLOR_SUCCESS,
  COLOR_WARNING,
  groundStyle,
  hairline,
  htmlTableCss,
  sectionCard,
  sectionHeader,
  statNumber,
  TEXT_SUBDUED,
  textSubdued,
  textSubduedSm,
} from "../styles/shared";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type SpeedLoaderData =
  | { access: "locked"; pricingPlansUrl: string; trialEligible: boolean }
  | ({ access: "pro"; runNowAvailableAt: string | null } & SpeedReportView);

export const loader = async ({ request }: LoaderFunctionArgs): Promise<SpeedLoaderData> => {
  const { session } = await authenticate.admin(request);
  if (!isSpeedReportLive()) throw new Response("Not found", { status: 404 });

  const shop = await getShopMetadata(session.shop);
  if (!shop) throw new Response("Shop not found", { status: 404 });

  if (!getPlanFeatures(shop.plan).speedReport) {
    // Teaser only: no report data is read for a plan without the feature.
    // gc-iirv: the teaser's upgrade ask joins the nudge funnel. `shown` once
    // per merchant: the stored stamp skips the claim query on later loads; the
    // atomic claim dedupes concurrent first loads. Never throws.
    if (shop.speedTeaserShownAt === null) {
      await recordNudgeStageOnce(NUDGE_KEYS.SPEED_TEASER, "shown", session.shop);
    }
    return {
      access: "locked",
      pricingPlansUrl: buildPricingPlansUrl(session.shop),
      trialEligible: await getTrialEligibility(shop),
    };
  }

  const now = new Date();
  const [rows, requestedAt] = await Promise.all([
    getRecentSpeedReports(shop.id),
    getSpeedReportRequestedAt(shop.id),
  ]);
  return {
    access: "pro",
    ...buildSpeedReportView(rows, now),
    runNowAvailableAt: runNowAvailableAt(requestedAt, now)?.toISOString() ?? null,
  };
};

// ---------------------------------------------------------------------------
// Action: "Run speed test now"
// ---------------------------------------------------------------------------

export type SpeedActionData = { ok: true } | { ok: false; error: string; nextAvailableAt?: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<SpeedActionData> => {
  const { session } = await authenticate.admin(request);
  if (!isSpeedReportLive()) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  if (formData.get("intent") !== "run-now") return { ok: false, error: "Unknown request." };

  // Session shop only: the form never carries a shop id.
  const shop = await getShopMetadata(session.shop);
  if (!shop) return { ok: false, error: "Shop not found. Please reinstall the app." };

  const result = await requestSpeedReportRunNow(shop, new Date());
  if (result.ok) return { ok: true };
  return {
    ok: false,
    error: result.error,
    ...(result.nextAvailableAt ? { nextAvailableAt: result.nextAvailableAt } : {}),
  };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TABLE_CLASS = "speed-cost-table";

const TONE_COLOR = {
  success: COLOR_SUCCESS,
  warning: COLOR_WARNING,
  critical: COLOR_CRITICAL,
} as const;

function MetricTile({
  label,
  value,
  delta,
  color,
}: {
  label: string;
  value: string;
  delta: string | null;
  color?: string;
}) {
  return (
    <div className="speed-metric">
      <div style={textSubduedSm}>{label}</div>
      <div style={{ ...statNumber, marginTop: "6px", ...(color ? { color } : {}) }}>{value}</div>
      {delta && <div style={{ ...textSubduedSm, marginTop: "4px" }}>{delta}</div>}
    </div>
  );
}

function CostTable({ rows, nameHeading }: { rows: SpeedCostRow[]; nameHeading: string }) {
  return (
    <table className={TABLE_CLASS}>
      <thead>
        <tr>
          <th scope="col">{nameHeading}</th>
          <th scope="col">Processing time</th>
          <th scope="col">Time it froze the page</th>
          <th scope="col">Download size</th>
          <th scope="col">Unused code</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td>{row.name}</td>
            <td>{formatSeconds(row.mainThreadMs)}</td>
            <td>{formatSeconds(row.blockingMs)}</td>
            <td>{formatBytes(row.transferBytes)}</td>
            <td>{row.unusedPct === null ? "Not measured" : `${row.unusedPct}% unused`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export function SpeedPageSection({
  page,
  previous,
}: {
  page: SpeedPageResult;
  previous: SpeedPageResult | undefined;
}) {
  const label = SPEED_PAGE_LABELS[page.page];
  const path = pathOf(page.url);

  if (page.status !== "OK" || !page.metrics) {
    const message =
      page.status === "NO_PRODUCT"
        ? NO_PRODUCT_MESSAGE
        : page.status === "NEEDS_PRODUCT_ACCESS"
          ? NEEDS_PRODUCT_ACCESS_MESSAGE
          : page.status === "PASSWORD"
            ? PASSWORD_PROTECTED_MESSAGE
            : `This page wasn't tested this time. ${speedFailureMessage(page.failureCode)}`;
    return (
      <div style={{ ...sectionCard, marginBottom: 0 }}>
        <h2 style={sectionHeader}>{label}</h2>
        <s-paragraph>{message}</s-paragraph>
        {page.status === "NEEDS_PRODUCT_ACCESS" && (
          <s-paragraph>
            <Link to="/app/settings">Open Settings</Link>
          </s-paragraph>
        )}
      </div>
    );
  }

  const m = page.metrics;
  const delta = speedPageDelta(page, previous);
  const tone = speedScoreTone(m.score);
  const apps = page.apps ?? [];
  const others = page.otherThirdParty ?? [];
  const headline = appCostHeadline(apps, page.page);

  return (
    <div style={{ ...sectionCard, marginBottom: 0 }}>
      <h2 style={sectionHeader}>{label}</h2>
      {path && (
        <div style={{ ...textSubduedSm, marginTop: "-8px", marginBottom: "12px" }}>{path}</div>
      )}
      <div className="speed-metrics">
        <MetricTile
          label={SPEED_METRIC_LABELS.score}
          value={m.score === null ? "Not available" : `${m.score} / 100`}
          delta={formatSpeedDelta("score", delta?.score ?? null)}
          color={tone ? TONE_COLOR[tone] : undefined}
        />
        <MetricTile
          label={SPEED_METRIC_LABELS.lcp}
          value={formatSeconds(m.lcpMs)}
          delta={formatSpeedDelta("time", delta?.lcpMs ?? null)}
        />
        <MetricTile
          label={SPEED_METRIC_LABELS.tbt}
          value={formatSeconds(m.tbtMs)}
          delta={formatSpeedDelta("time", delta?.tbtMs ?? null)}
        />
        <MetricTile
          label={SPEED_METRIC_LABELS.weight}
          value={formatBytes(m.totalBytes)}
          delta={formatSpeedDelta("bytes", delta?.totalBytes ?? null)}
        />
        <MetricTile
          label={SPEED_METRIC_LABELS.requests}
          value={m.requestCount === null ? "Not available" : String(m.requestCount)}
          delta={null}
        />
      </div>

      <h3 style={{ ...sectionHeader, fontSize: "16px", marginTop: "20px" }}>
        Apps slowing your store
      </h3>
      {headline && <s-paragraph>{headline}</s-paragraph>}
      {apps.length > 0 ? (
        <CostTable rows={apps} nameHeading="App" />
      ) : (
        <s-paragraph>No known app added measurable load to this page.</s-paragraph>
      )}

      {others.length > 0 && (
        <>
          <h3 style={{ ...sectionHeader, fontSize: "16px", marginTop: "20px" }}>
            Other third-party code
          </h3>
          <div style={{ ...textSubdued, marginBottom: "8px" }}>
            Code from other services we can&apos;t match to an app, by where it loads from.
          </div>
          <CostTable rows={others} nameHeading="Loads from" />
        </>
      )}
    </div>
  );
}

export function StatusBanner({
  latest,
  canRunNow,
  pollingTimedOut,
}: {
  latest: SpeedReportSummaryView | null;
  /** Run now is available (not in its 24h cooldown). */
  canRunNow: boolean;
  /** The page stopped polling (~10 min) while the run was still going. */
  pollingTimedOut: boolean;
}) {
  if (!latest) {
    return (
      <s-banner tone="info">
        <s-paragraph>Your first speed report runs on Sunday. You can also run it now.</s-paragraph>
      </s-banner>
    );
  }
  switch (latest.status) {
    case SPEED_REPORT_STATUS.RUNNING:
      return (
        <s-banner tone="info">
          <s-paragraph>
            {pollingTimedOut
              ? "Still running. Refresh the page in a few minutes to see the results."
              : "Speed test running. It takes a few minutes; results appear here when it finishes."}
          </s-paragraph>
        </s-banner>
      );
    case SPEED_REPORT_STATUS.UNAVAILABLE_PASSWORD:
      return (
        <s-banner tone="warning">
          <s-paragraph>{PASSWORD_PROTECTED_MESSAGE}</s-paragraph>
        </s-banner>
      );
    case SPEED_REPORT_STATUS.SKIPPED_BUDGET:
      return (
        <s-banner tone="warning">
          <s-paragraph>
            {speedFailureMessage("budget")} Your next report runs on schedule.
          </s-paragraph>
        </s-banner>
      );
    case SPEED_REPORT_STATUS.FAILED:
      return (
        <s-banner tone="critical">
          <s-paragraph>
            We couldn&apos;t test your store on <FormattedDate value={latest.createdAt} />.{" "}
            {speedFailureMessage(latest.failureReason)}{" "}
            {canRunNow
              ? "We'll try again next week, or you can run it now."
              : "We'll try again next week."}
          </s-paragraph>
        </s-banner>
      );
    default:
      return null;
  }
}

function RunNowControl({ availableAt }: { availableAt: string | null }) {
  const fetcher = useFetcher<SpeedActionData>();
  const submitting = fetcher.state !== "idle";
  const result = fetcher.data;
  const nextAt = availableAt ?? (result && !result.ok ? (result.nextAvailableAt ?? null) : null);

  return (
    <s-stack direction="block" gap="small-200">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="run-now" />
        <s-button
          type="submit"
          variant="primary"
          {...(nextAt ? { disabled: true } : {})}
          {...(submitting ? { loading: true } : {})}
        >
          Run speed test now
        </s-button>
      </fetcher.Form>
      {nextAt && (
        <span style={textSubduedSm}>
          Next test available <FormattedDate value={nextAt} includeTime />
        </span>
      )}
      {result && !result.ok && <s-text tone="critical">{result.error}</s-text>}
    </s-stack>
  );
}

export function LockedTeaser({
  pricingPlansUrl,
  trialEligible,
}: {
  pricingPlansUrl: string;
  trialEligible: boolean;
}) {
  return (
    <div style={{ ...sectionCard, marginBottom: 0 }}>
      <h2 style={sectionHeader}>{SPEED_TEASER_HEADING}</h2>
      <s-paragraph>{SPEED_TEASER_BODY}</s-paragraph>
      <div style={{ marginTop: "16px" }}>
        {/* Same proven upgrade link as the Settings plan tiles, plus the
            best-effort click ping (gc-iirv). */}
        <a
          href={pricingPlansUrl}
          target="_top"
          rel="noreferrer"
          onClick={() => recordUpgradeClick("speed_teaser")}
        >
          <s-button variant="primary">
            {upgradeCtaLabel(PLANS.PROFESSIONAL, trialEligible)}
          </s-button>
        </a>
      </div>
    </div>
  );
}

export default function StoreSpeed() {
  const data = useLoaderData<typeof loader>();
  const running = data.access === "pro" && data.latest?.status === SPEED_REPORT_STATUS.RUNNING;
  // Reuse the scan page's capped revalidation poll while a run is in progress.
  const { pollingTimedOut } = useScanPolling(running ? "IN_PROGRESS" : null);

  return (
    <s-page heading="Store speed">
      <Link to="/app" slot="primary-action">
        Back to Dashboard
      </Link>
      <div style={hairline} />
      <div style={groundStyle}>
        <style>{`
          ${htmlTableCss(TABLE_CLASS)}
          .speed-metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 16px;
          }
        `}</style>
        {data.access === "locked" ? (
          <LockedTeaser pricingPlansUrl={data.pricingPlansUrl} trialEligible={data.trialEligible} />
        ) : (
          <>
            <div style={{ ...sectionCard, marginBottom: 0 }}>
              <s-stack direction="block" gap="base">
                <s-paragraph>{SPEED_INTRO}</s-paragraph>
                {data.lastResults && (
                  <span style={{ color: TEXT_SUBDUED, fontSize: "13px" }}>
                    Results from <FormattedDate value={data.lastResults.createdAt} includeTime />
                  </span>
                )}
                <RunNowControl availableAt={running ? null : data.runNowAvailableAt} />
              </s-stack>
            </div>
            <StatusBanner
              latest={data.latest}
              canRunNow={data.runNowAvailableAt === null}
              pollingTimedOut={pollingTimedOut}
            />
            {data.lastResults?.pages.map((page) => (
              <SpeedPageSection
                key={`${data.lastResults!.id}-${page.page}`}
                page={page}
                previous={data.previousResults?.pages.find((p) => p.page === page.page)}
              />
            ))}
            {data.lastResults && <div style={textSubduedSm}>{SPEED_CAVEAT}</div>}
          </>
        )}
      </div>
    </s-page>
  );
}

export { AppErrorBoundary as ErrorBoundary } from "../components/AppErrorBoundary";
