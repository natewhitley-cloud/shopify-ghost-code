/**
 * Trimmed but real-shaped PageSpeed Insights v5 `lighthouseResult` (Lighthouse
 * 12, mobile) for the store speed report tests (gc-wt3y). Field names and
 * nesting follow the live API (audits[id].numericValue, details.items,
 * third-party-summary subItems, finalDisplayedUrl); the numbers are modeled on
 * the paw-naturals local Lighthouse run of 2026-10-05 (score ~28, LCP ~14 s,
 * TBT ~9 s, ~8 MB), cut down to a handful of requests per owner.
 *
 * Owners in this fixture:
 *   - Klaviyo   static.klaviyo.com (third-party-summary subItem + bootup) and an
 *               app-embed file on cdn.shopify.com/extensions/.../klaviyo... that
 *               is only in bootup-time (no subItem) -> both count for Klaviyo.
 *   - Recharge  static.rechargecdn.com, 80% unused JS.
 *   - Google Fonts (fonts.googleapis.com / fonts.gstatic.com): unmatched
 *               -> "other third-party", grouped by host.
 *   - Shopify first party: the store's own host and cdn.shopify.com theme
 *               files -> page totals only, never an app row.
 *   - Lighthouse's per-entity "Other resources" remainder row (no URL) -> skipped.
 */

export const STORE_HOST = "paw-naturals.example";
export const MYSHOPIFY_HOST = "paw-naturals.myshopify.com";
export const STORE_HOSTS = [STORE_HOST, MYSHOPIFY_HOST];

export const URLS = {
  document: `https://${STORE_HOST}/`,
  themeJs: `https://${STORE_HOST}/cdn/shop/t/3/assets/global.js`,
  shopifyCdn: "https://cdn.shopify.com/s/files/1/0001/t/3/assets/theme.css",
  klaviyo: "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=ABC123",
  klaviyoImage: "https://static.klaviyo.com/onsite/images/popup-hero.png",
  klaviyoEmbed: "https://cdn.shopify.com/extensions/0199abcd/klaviyo-onsite-12/assets/onsite.js",
  recharge: "https://static.rechargecdn.com/assets/js/widget.min.js",
  fontsCss: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700",
  fontsFile: "https://fonts.gstatic.com/s/inter/v13/inter-400.woff2",
} as const;

type Overrides = {
  score?: number | null;
  finalDisplayedUrl?: string;
  lcpMs?: number;
  tbtMs?: number;
  totalBytes?: number;
  /** Replace the whole audits object (malformed-input tests). */
  audits?: Record<string, unknown>;
  runtimeError?: { code: string; message: string };
};

/** A fresh fixture (deep, so a test can mutate its copy). */
export function buildLighthouseResult(overrides: Overrides = {}): Record<string, unknown> {
  const audits: Record<string, unknown> = overrides.audits ?? {
    "largest-contentful-paint": {
      id: "largest-contentful-paint",
      numericValue: overrides.lcpMs ?? 14212.4,
      displayValue: "14.2 s",
    },
    "total-blocking-time": {
      id: "total-blocking-time",
      numericValue: overrides.tbtMs ?? 9033.6,
      displayValue: "9,030 ms",
    },
    "cumulative-layout-shift": { id: "cumulative-layout-shift", numericValue: 0.112 },
    "first-contentful-paint": { id: "first-contentful-paint", numericValue: 4021.7 },
    "speed-index": { id: "speed-index", numericValue: 11890.2 },
    "total-byte-weight": {
      id: "total-byte-weight",
      numericValue: overrides.totalBytes ?? 8123456,
      displayValue: "Total size was 7,933 KiB",
    },
    diagnostics: {
      id: "diagnostics",
      details: { type: "debugdata", items: [{ numRequests: 661, numScripts: 140 }] },
    },
    "network-requests": {
      id: "network-requests",
      details: {
        type: "table",
        items: [
          { url: URLS.document, transferSize: 52000, resourceType: "Document", statusCode: 200 },
          { url: URLS.themeJs, transferSize: 120000, resourceType: "Script", statusCode: 200 },
          { url: URLS.shopifyCdn, transferSize: 80000, resourceType: "Stylesheet" },
          { url: URLS.klaviyo, transferSize: 621000, resourceType: "Script", statusCode: 200 },
          { url: URLS.klaviyoImage, transferSize: 1200000, resourceType: "Image" },
          { url: URLS.klaviyoEmbed, transferSize: 30000, resourceType: "Script" },
          { url: URLS.recharge, transferSize: 169000, resourceType: "Script" },
          { url: URLS.fontsCss, transferSize: 2000, resourceType: "Stylesheet" },
          { url: URLS.fontsFile, transferSize: 48000, resourceType: "Font" },
          { url: "data:image/svg+xml;base64,AAAA", transferSize: 0, resourceType: "Image" },
        ],
      },
    },
    "third-party-summary": {
      id: "third-party-summary",
      details: {
        type: "table",
        items: [
          {
            entity: "Klaviyo",
            transferSize: 1821000,
            mainThreadTime: 4012.5,
            blockingTime: 2100.2,
            subItems: {
              type: "subitems",
              items: [
                {
                  url: URLS.klaviyo,
                  transferSize: 621000,
                  mainThreadTime: 3900.4,
                  blockingTime: 2050.1,
                },
                {
                  url: URLS.klaviyoImage,
                  transferSize: 1200000,
                  mainThreadTime: 12.1,
                  blockingTime: 0,
                },
                // Lighthouse's remainder row: a label, not a URL.
                {
                  url: "Other resources",
                  transferSize: 900,
                  mainThreadTime: 100,
                  blockingTime: 50,
                },
              ],
            },
          },
          {
            entity: "Recharge",
            transferSize: 169000,
            mainThreadTime: 640,
            blockingTime: 310,
            subItems: {
              type: "subitems",
              items: [
                {
                  url: URLS.recharge,
                  transferSize: 169000,
                  mainThreadTime: 640,
                  blockingTime: 310,
                },
              ],
            },
          },
          {
            entity: "Google Fonts",
            transferSize: 50000,
            mainThreadTime: 0,
            blockingTime: 0,
            subItems: {
              type: "subitems",
              items: [
                { url: URLS.fontsCss, transferSize: 2000, mainThreadTime: 0, blockingTime: 0 },
                { url: URLS.fontsFile, transferSize: 48000, mainThreadTime: 0, blockingTime: 0 },
              ],
            },
          },
        ],
      },
    },
    "bootup-time": {
      id: "bootup-time",
      details: {
        type: "table",
        items: [
          { url: URLS.document, total: 1500, scripting: 900, scriptParseCompile: 40 },
          { url: URLS.themeJs, total: 700, scripting: 650, scriptParseCompile: 30 },
          // Also in third-party-summary: the summary's 3900.4 wins, never summed.
          { url: URLS.klaviyo, total: 3800, scripting: 3500, scriptParseCompile: 120 },
          // Only here: the app embed on cdn.shopify.com counts for Klaviyo.
          { url: URLS.klaviyoEmbed, total: 210, scripting: 190, scriptParseCompile: 10 },
          { url: URLS.recharge, total: 600, scripting: 560, scriptParseCompile: 20 },
        ],
      },
    },
    "unused-javascript": {
      id: "unused-javascript",
      details: {
        type: "opportunity",
        items: [
          { url: URLS.recharge, totalBytes: 169000, wastedBytes: 135200, wastedPercent: 80 },
          { url: URLS.klaviyo, totalBytes: 621000, wastedBytes: 310500, wastedPercent: 50 },
        ],
      },
    },
  };

  return {
    lighthouseVersion: "12.2.1",
    requestedUrl: URLS.document,
    mainDocumentUrl: overrides.finalDisplayedUrl ?? URLS.document,
    finalDisplayedUrl: overrides.finalDisplayedUrl ?? URLS.document,
    fetchTime: "2026-10-05T14:00:00.000Z",
    ...(overrides.runtimeError ? { runtimeError: overrides.runtimeError } : {}),
    categories: {
      performance: {
        id: "performance",
        score: overrides.score === undefined ? 0.28 : overrides.score,
      },
    },
    audits,
  };
}

/** The PageSpeed v5 response envelope around a lighthouseResult. */
export function buildPageSpeedResponse(overrides: Overrides = {}): Record<string, unknown> {
  return {
    captchaResult: "CAPTCHA_NOT_NEEDED",
    kind: "pagespeedonline#result",
    id: URLS.document,
    analysisUTCTimestamp: "2026-10-05T14:00:00.000Z",
    lighthouseResult: buildLighthouseResult(overrides),
  };
}

/** Google's error envelope (e.g. a page Lighthouse could not load). */
export function buildPageSpeedError(code: number, message: string): Record<string, unknown> {
  return {
    error: {
      code,
      message,
      errors: [{ message, domain: "lighthouse", reason: "lighthouseUserError" }],
    },
  };
}
