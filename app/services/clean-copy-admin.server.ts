/**
 * Clean copy Admin API adapter (gc-tib slice 4).
 *
 * The ONLY module that talks to Shopify for the clean-copy fix. A narrow
 * interface so the orchestrator is tested against a mock, plus the GraphQL
 * implementation over the Admin client.
 *
 * Operations: read the MAIN theme, read one theme, find an UNPUBLISHED theme
 * by exact name (crash-safe adoption of a copy we already made), duplicate a
 * theme, read up to 50 files, upsert up to 50 files, read a job.
 *
 * Deliberately absent: themePublish, themeDelete, themeFilesDelete,
 * themeFilesCopy, themeCreate, themeUpdate (spike D2: the merchant publishes).
 *
 * HARD GUARD: every upsert re-reads the target theme first and refuses unless
 * its role is UNPUBLISHED, it is not processing, and its id is not the run's
 * source (MAIN) theme. Every filename must be an allowed fix path. The guard
 * lives here, below the orchestrator, so no caller bug can write MAIN.
 *
 * Errors: never throws a raw GraphQL error. ACCESS_DENIED (scope or missing
 * exemption) is its own typed result; every other failure is TRANSIENT. The
 * result message carries error CODES only, never GraphQL message text, which
 * can echo variables (file bodies). Theme content never leaves this process
 * except in the upsert request itself (privacy policy: no theme content in
 * logs or Inngest).
 *
 * API version: the app's (ApiVersion.July26 in app/shopify.server.ts); all
 * operations below were validated against the 2026-07 Admin schema.
 */

import { resolvePlanFromSubscription } from "../lib/billing.server";
import { PLANS } from "../lib/plans";
import { thrownGraphqlResponse } from "../lib/rate-limit-monitor.server";
import { isAccessDeniedError, type GraphQLResponseError } from "../lib/scope-check.server";
import type { AdminApiContext } from "../types/shopify";

/** Shopify limits: files(filenames:) and themeFilesUpsert both take at most 50. */
export const MAX_FILES_PER_REQUEST = 50;

/**
 * Files the clean copy may edit (spike §4): Liquid under layout/, sections/,
 * snippets/, templates/ or blocks/. Never assets/, config/, locales/ or JSON.
 */
const ALLOWED_FIX_PATH = /^(?:layout|sections|snippets|templates|blocks)\/[^/]+\.liquid$/;

export function isAllowedFixPath(filename: string): boolean {
  return ALLOWED_FIX_PATH.test(filename) && !filename.includes("..");
}

export type ThemeInfo = {
  id: string;
  name: string;
  /** MAIN | UNPUBLISHED | DEVELOPMENT | DEMO | ARCHIVED | LOCKED ... */
  role: string;
  processing: boolean;
  processingFailed: boolean;
  updatedAt: Date | null;
};

export type CopyFile = {
  filename: string;
  checksumMd5: string | null;
  /** Text body, or null when Shopify returned no text body. */
  content: string | null;
};

export type AdminError =
  /** Scope or exemption missing. Never retried. */
  | "ACCESS_DENIED"
  /** The mutation returned userErrors. */
  | "USER_ERROR"
  /** Write refused by the adapter's guard (target not a safe copy). */
  | "WRITE_REFUSED"
  /** Network, throttle, 5xx, malformed response: retry may help. */
  | "TRANSIENT";

export type AdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminError; message: string };

export type UpsertResult = {
  /** Null when Shopify returned no job (nothing to wait for). */
  jobId: string | null;
  jobDone: boolean;
  /**
   * Non-access userErrors, codes only (allowlisted). The job is still returned
   * with them (audit M-e): Shopify may apply the other files, so the caller
   * waits for the job and trusts the post-read checksums.
   */
  userErrors: Array<{ filename: string | null; code: string }>;
};

export interface CleanCopyAdmin {
  getMainTheme(): Promise<AdminResult<ThemeInfo | null>>;
  getTheme(themeId: string): Promise<AdminResult<ThemeInfo | null>>;
  /** An UNPUBLISHED theme whose name equals `name` exactly, or null. */
  findUnpublishedThemeByName(name: string): Promise<AdminResult<ThemeInfo | null>>;
  duplicateTheme(sourceThemeId: string, name: string): Promise<AdminResult<ThemeInfo>>;
  readFiles(themeId: string, filenames: readonly string[]): Promise<AdminResult<CopyFile[]>>;
  /** Guarded write: see the module comment. */
  upsertFiles(input: {
    themeId: string;
    sourceThemeId: string;
    files: ReadonlyArray<{ filename: string; content: string }>;
  }): Promise<AdminResult<UpsertResult>>;
  getJob(jobId: string): Promise<AdminResult<{ done: boolean }>>;
  /** Every access scope handle granted to this installation, read live. */
  getGrantedScopes(): Promise<AdminResult<string[]>>;
  /**
   * The installation's ACTIVE Professional subscription, read live (gc-tib.22),
   * or null when there is none. A malformed subscription is TRANSIENT, never a
   * guess.
   */
  getProfessionalSubscription(): Promise<AdminResult<ProfessionalSubscription | null>>;
}

export type ProfessionalSubscription = {
  /** When the free trial ends; null when the subscription has no trial days. */
  trialEndsAt: Date | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trial end of an AppSubscription: `trialDays` whole days from `createdAt`
 * (Admin API: "free trial days, starting at the subscription's creation
 * date"), rounded UP to the next 00:00 UTC, because Shopify counts trial days
 * in whole UTC calendar days. Rounding up keeps the trial limit on for at most
 * one extra day, never lifts it early. Null for no trial; undefined when the
 * fields are malformed.
 */
export function subscriptionTrialEnd(
  createdAt: unknown,
  trialDays: unknown,
): Date | null | undefined {
  if (typeof trialDays !== "number" || !Number.isInteger(trialDays) || trialDays < 0) {
    return undefined;
  }
  // An explicit Z or offset only: a zoneless time would be read in the
  // server's own time zone (audit r8 F3).
  if (typeof createdAt !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(createdAt)) {
    return undefined;
  }
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return undefined;
  if (trialDays === 0) return null;
  const end = Math.ceil((created + trialDays * DAY_MS) / DAY_MS) * DAY_MS;
  // A huge trialDays overflows the Date range: malformed, never "no trial".
  const date = new Date(end);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * TODO(gc-dg5e) D9: Canvas themes are excluded from v1, but there is no
 * reliable Canvas signal yet. When gc-dg5e reports one, return "CANVAS_THEME"
 * for a Canvas theme here; preflight and the selection page already refuse on
 * any non-null result. Until then this hook refuses nothing.
 */
export function canvasThemeRefusal(theme: ThemeInfo): "CANVAS_THEME" | null {
  void theme;
  return null;
}

// ---------------------------------------------------------------------------
// GraphQL operations (validated against Admin API 2026-07)
// ---------------------------------------------------------------------------

const THEME_FIELDS = "id name role processing processingFailed updatedAt";

const MAIN_THEME_QUERY = `query CleanCopyMain { themes(first: 1, roles: [MAIN]) { nodes { ${THEME_FIELDS} } } }`;

const THEME_QUERY = `query CleanCopyTheme($id: ID!) { theme(id: $id) { ${THEME_FIELDS} } }`;

const THEMES_BY_NAME_QUERY = `query CleanCopyThemesByName($names: [String!], $after: String) {
  themes(first: 50, names: $names, roles: [UNPUBLISHED], after: $after) {
    nodes { ${THEME_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const DUPLICATE_MUTATION = `mutation CleanCopyDuplicate($id: ID!, $name: String) {
  themeDuplicate(id: $id, name: $name) {
    newTheme { ${THEME_FIELDS} }
    userErrors { code field message }
  }
}`;

const FILES_QUERY = `query CleanCopyFiles($id: ID!, $filenames: [String!]) {
  theme(id: $id) {
    files(filenames: $filenames, first: 50) {
      nodes {
        filename
        checksumMd5
        body { ... on OnlineStoreThemeFileBodyText { content } }
      }
    }
  }
}`;

const UPSERT_MUTATION = `mutation CleanCopyUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $themeId, files: $files) {
    job { id done }
    upsertedThemeFiles { filename }
    userErrors { code field filename message }
  }
}`;

const JOB_QUERY = `query CleanCopyJob($id: ID!) { job(id: $id) { id done } }`;

const ACCESS_SCOPES_QUERY = `query CleanCopyScopes { currentAppInstallation { accessScopes { handle } } }`;

const SUBSCRIPTIONS_QUERY = `query CleanCopySubscriptions { currentAppInstallation { activeSubscriptions { name status createdAt trialDays } } }`;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MAX_MESSAGE_CHARS = 300;
const MAX_THEME_PAGES = 5;

type UserError = { code?: string | null; field?: string[] | null; message?: string | null };

const fail = (
  error: AdminError,
  message: string,
): { ok: false; error: AdminError; message: string } => ({
  ok: false,
  error,
  message: message.slice(0, MAX_MESSAGE_CHARS),
});

function toTheme(node: Record<string, unknown> | null | undefined): ThemeInfo | null {
  if (!node || typeof node.id !== "string") return null;
  const updated = typeof node.updatedAt === "string" ? new Date(node.updatedAt) : null;
  return {
    id: node.id,
    name: typeof node.name === "string" ? node.name : "",
    role: typeof node.role === "string" ? node.role : "",
    processing: node.processing === true,
    processingFailed: node.processingFailed === true,
    updatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : null,
  };
}

/**
 * Error codes only, never GraphQL message text: a mutation error can echo its
 * variables (file bodies), and theme content must never reach logs or Inngest
 * (privacy policy). Classification still reads the messages.
 */
/** Only a plain machine code passes (audit sec 8); anything else is UNKNOWN. */
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

export function safeCode(code: unknown): string {
  return typeof code === "string" && SAFE_CODE.test(code) ? code : "UNKNOWN";
}

function codesOf(codes: unknown[]): string {
  const list = [...new Set(codes.map(safeCode))];
  return list.join(",") || "UNKNOWN";
}

function classifyErrors(errors: GraphQLResponseError[]): {
  ok: false;
  error: AdminError;
  message: string;
} {
  const message = `graphql errors: ${codesOf(errors.map((e) => e.extensions?.code))}`;
  return fail(errors.some(isAccessDeniedError) ? "ACCESS_DENIED" : "TRANSIENT", message);
}

/** userErrors -> typed failure (an access-denied userError is ACCESS_DENIED). */
function classifyUserErrors(userErrors: UserError[]): {
  ok: false;
  error: AdminError;
  message: string;
} {
  const denied = userErrors.some((e) =>
    isAccessDeniedError({ message: e.message ?? "", extensions: { code: e.code ?? undefined } }),
  );
  const message = `userErrors: ${codesOf(userErrors.map((e) => e.code))}`;
  return fail(denied ? "ACCESS_DENIED" : "USER_ERROR", message);
}

export function createCleanCopyAdmin(admin: AdminApiContext): CleanCopyAdmin {
  async function call(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<AdminResult<Record<string, unknown>>> {
    let json: { data?: Record<string, unknown> | null; errors?: GraphQLResponseError[] };
    try {
      const response = await admin.graphql(query, variables ? { variables } : undefined);
      json = (await response.json()) as typeof json;
    } catch (err) {
      const thrown = thrownGraphqlResponse(err);
      if (thrown && thrown.errors.length > 0) {
        return classifyErrors(thrown.errors as GraphQLResponseError[]);
      }
      const raw = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "Error";
      return fail(
        isAccessDeniedError({ message: raw }) ? "ACCESS_DENIED" : "TRANSIENT",
        `request failed: ${name}`,
      );
    }
    if (json.errors && json.errors.length > 0) return classifyErrors(json.errors);
    if (!json.data) return fail("TRANSIENT", "empty GraphQL response");
    return { ok: true, value: json.data };
  }

  async function getTheme(themeId: string): Promise<AdminResult<ThemeInfo | null>> {
    const res = await call(THEME_QUERY, { id: themeId });
    if (!res.ok) return res;
    return { ok: true, value: toTheme(res.value.theme as Record<string, unknown> | null) };
  }

  return {
    async getMainTheme() {
      const res = await call(MAIN_THEME_QUERY);
      if (!res.ok) return res;
      const nodes = (res.value.themes as { nodes?: Array<Record<string, unknown>> } | undefined)
        ?.nodes;
      return { ok: true, value: toTheme(nodes?.[0]) };
    },

    getTheme,

    async findUnpublishedThemeByName(name) {
      let after: string | null = null;
      for (let page = 0; page < MAX_THEME_PAGES; page++) {
        const res = await call(THEMES_BY_NAME_QUERY, { names: [name], after });
        if (!res.ok) return res;
        const conn = res.value.themes as
          | {
              nodes?: Array<Record<string, unknown>>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            }
          | undefined;
        // Exact match only, whatever the API's name filter does.
        const hit = (conn?.nodes ?? [])
          .map(toTheme)
          .find((t) => t !== null && t.name === name && t.role === "UNPUBLISHED");
        if (hit) return { ok: true, value: hit };
        if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
        after = conn.pageInfo.endCursor;
      }
      return { ok: true, value: null };
    },

    async duplicateTheme(sourceThemeId, name) {
      const res = await call(DUPLICATE_MUTATION, { id: sourceThemeId, name });
      if (!res.ok) return res;
      const payload = res.value.themeDuplicate as
        | { newTheme?: Record<string, unknown> | null; userErrors?: UserError[] }
        | null
        | undefined;
      if (payload?.userErrors && payload.userErrors.length > 0) {
        return classifyUserErrors(payload.userErrors);
      }
      const theme = toTheme(payload?.newTheme);
      if (!theme) return fail("TRANSIENT", "themeDuplicate returned no theme");
      return { ok: true, value: theme };
    },

    async readFiles(themeId, filenames) {
      if (filenames.length === 0) return { ok: true, value: [] };
      if (filenames.length > MAX_FILES_PER_REQUEST) {
        return fail("WRITE_REFUSED", `at most ${MAX_FILES_PER_REQUEST} files per read`);
      }
      const res = await call(FILES_QUERY, { id: themeId, filenames: [...filenames] });
      if (!res.ok) return res;
      const theme = res.value.theme as
        | { files?: { nodes?: Array<Record<string, unknown>> } }
        | null
        | undefined;
      if (!theme) return fail("TRANSIENT", "theme not found while reading files");
      const files: CopyFile[] = (theme.files?.nodes ?? []).map((node) => {
        const body = node.body as { content?: unknown } | null | undefined;
        return {
          filename: String(node.filename),
          checksumMd5:
            typeof node.checksumMd5 === "string" && node.checksumMd5 !== ""
              ? node.checksumMd5
              : null,
          content: typeof body?.content === "string" ? body.content : null,
        };
      });
      return { ok: true, value: files };
    },

    async upsertFiles({ themeId, sourceThemeId, files }) {
      // ---- HARD GUARD (never write MAIN / the source theme) ----
      if (themeId === sourceThemeId) {
        return fail("WRITE_REFUSED", "target is the source theme");
      }
      if (files.length === 0 || files.length > MAX_FILES_PER_REQUEST) {
        return fail(
          "WRITE_REFUSED",
          `file count ${files.length} outside 1..${MAX_FILES_PER_REQUEST}`,
        );
      }
      const badPath = files.find((f) => !isAllowedFixPath(f.filename));
      if (badPath) return fail("WRITE_REFUSED", "filename outside the allowed fix paths");
      const target = await getTheme(themeId);
      if (!target.ok) return target;
      if (!target.value) return fail("WRITE_REFUSED", "target theme not found");
      if (target.value.id !== themeId || target.value.role !== "UNPUBLISHED") {
        return fail("WRITE_REFUSED", `target role is ${target.value.role || "unknown"}`);
      }
      if (target.value.processing || target.value.processingFailed) {
        return fail("WRITE_REFUSED", "target theme is not ready");
      }
      // ---- end guard ----

      const res = await call(UPSERT_MUTATION, {
        themeId,
        files: files.map((f) => ({
          filename: f.filename,
          body: { type: "TEXT", value: f.content },
        })),
      });
      if (!res.ok) return res;
      const payload = res.value.themeFilesUpsert as
        | { job?: { id?: string; done?: boolean } | null; userErrors?: UserError[] }
        | null
        | undefined;
      const rawErrors = (payload?.userErrors ?? []) as Array<
        UserError & { filename?: string | null }
      >;
      if (rawErrors.length > 0) {
        const classified = classifyUserErrors(rawErrors);
        if (classified.error === "ACCESS_DENIED") return classified;
      }
      const jobId = typeof payload?.job?.id === "string" ? payload.job.id : null;
      return {
        ok: true,
        value: {
          jobId,
          jobDone: jobId === null || payload?.job?.done === true,
          userErrors: rawErrors.map((e) => ({
            filename: typeof e.filename === "string" ? e.filename : null,
            code: safeCode(e.code),
          })),
        },
      };
    },

    async getJob(jobId) {
      const res = await call(JOB_QUERY, { id: jobId });
      if (!res.ok) return res;
      const job = res.value.job as { done?: boolean } | null | undefined;
      if (!job) return fail("TRANSIENT", "job not found");
      return { ok: true, value: { done: job.done === true } };
    },

    async getGrantedScopes() {
      const res = await call(ACCESS_SCOPES_QUERY);
      if (!res.ok) return res;
      const scopes = (
        res.value.currentAppInstallation as { accessScopes?: Array<{ handle?: unknown }> } | null
      )?.accessScopes;
      if (!Array.isArray(scopes)) return fail("TRANSIENT", "no access scopes");
      return {
        ok: true,
        value: scopes.map((s) => s.handle).filter((h): h is string => typeof h === "string"),
      };
    },

    async getProfessionalSubscription() {
      const res = await call(SUBSCRIPTIONS_QUERY);
      if (!res.ok) return res;
      const subs = (
        res.value.currentAppInstallation as { activeSubscriptions?: unknown } | null | undefined
      )?.activeSubscriptions;
      if (!Array.isArray(subs)) return fail("TRANSIENT", "no active subscriptions list");
      // The reconciler's own mapping (name + ACTIVE status) picks Professional.
      const pro = subs.filter(
        (s): s is Record<string, unknown> =>
          typeof s === "object" &&
          s !== null &&
          resolvePlanFromSubscription(
            typeof s.name === "string" ? s.name : undefined,
            typeof s.status === "string" ? s.status : undefined,
          ) === PLANS.PROFESSIONAL,
      );
      if (pro.length === 0) return { ok: true, value: null };
      // Several (never expected): the latest trial end wins, so the limit
      // stays on while any of them is in trial.
      let trialEndsAt: Date | null = null;
      for (const s of pro) {
        const end = subscriptionTrialEnd(s.createdAt, s.trialDays);
        if (end === undefined) return fail("TRANSIENT", "malformed subscription trial fields");
        if (end !== null && (trialEndsAt === null || end > trialEndsAt)) trialEndsAt = end;
      }
      return { ok: true, value: { trialEndsAt } };
    },
  };
}
