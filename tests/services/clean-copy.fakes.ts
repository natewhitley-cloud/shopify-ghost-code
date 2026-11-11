/**
 * Test fakes for the clean-copy slice (gc-tib.4). Not a test file.
 *
 *   createFakeDb()   in-memory subset of the Prisma client: Shop, Scan,
 *                    Finding, FixRun, FixItem, honouring the where / orderBy /
 *                    skip / include shapes the clean-copy code uses, plus a
 *                    real per-key lock for pg_advisory_xact_lock.
 *   FakeShopify      an Admin GraphQL server for the 7 clean-copy operations,
 *                    so tests drive the REAL adapter (and its write guard).
 *
 * No database or network is touched.
 */
import { createHash } from "node:crypto";

export const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "NOT") {
      if (matches(row, cond as Row)) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; lt?: Date; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      if (c.lt && !((value as Date) < c.lt)) return false;
      if ("not" in c && value === c.not) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export function createFakeDb() {
  const state = {
    shops: [] as Row[],
    scans: [] as Row[],
    findings: [] as Row[],
    fixRuns: [] as Row[],
    fixItems: [] as Row[],
    lockSql: [] as string[],
    /** Throw once from the next fixRun.updateMany that sets copyThemeId. */
    failNextCopyThemeWrite: false,
  };
  let seq = 0;
  // Starts at real time: the model compares updatedAt with new Date().
  let clock = Date.now();
  const nextDate = () => new Date((clock += 1000));
  const locks = new Map<string, Promise<void>>();

  const withItems = (run: Row, include?: { items?: unknown }) =>
    include?.items
      ? {
          ...run,
          items: state.fixItems
            .filter((i) => i.fixRunId === run.id)
            .sort(
              (a, b) =>
                String(a.filename).localeCompare(String(b.filename)) ||
                (a.spanStart as number) - (b.spanStart as number),
            )
            .map((i) => ({ ...i })),
        }
      : { ...run };

  const fixItem = {
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      await tick();
      // Relation filter on the parent run (e.g. only while it is active).
      const { fixRun: runWhere, ...own } = where as Row & { fixRun?: Row };
      const rows = state.fixItems.filter(
        (r) =>
          matches(r, own) &&
          (!runWhere ||
            matches(state.fixRuns.find((run) => run.id === r.fixRunId) ?? {}, runWhere)),
      );
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  };

  const fixRun = {
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      await tick();
      if (state.failNextCopyThemeWrite && "copyThemeId" in data) {
        state.failNextCopyThemeWrite = false;
        throw new Error("simulated crash before the copy id was saved");
      }
      const rows = state.fixRuns.filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data, { updatedAt: nextDate() }));
      return { count: rows.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = state.fixRuns.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: nextDate() });
      return { ...row };
    },
    findFirst: async ({ where }: { where: Row }) => {
      await tick();
      const row = state.fixRuns.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    findUnique: async ({
      where,
      include,
      select,
    }: {
      where: Row;
      include?: { items?: unknown };
      select?: { items?: unknown };
    }) => {
      const row = state.fixRuns.find((r) => r.id === where.id);
      if (!row) return null;
      return withItems(row, include ?? select);
    },
    create: async ({ data }: { data: Row & { items?: { create: Row[] } } }) => {
      await tick();
      const id = `run-${String(++seq).padStart(8, "0")}`;
      const now = nextDate();
      const { items, ...rest } = data;
      const row: Row = {
        id,
        copyThemeId: null,
        copyThemeName: null,
        copyCreatedAt: null,
        status: "pending",
        failureReason: null,
        doNotPublish: false,
        copyGoneAt: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        ...rest,
      };
      state.fixRuns.push(row);
      for (const item of items?.create ?? []) {
        state.fixItems.push({
          id: `item-${++seq}`,
          fixRunId: id,
          postMd5: null,
          status: "pending",
          reasonCode: null,
          findingType: null,
          ...item,
        });
      }
      return { id };
    },
    findMany: async ({ where, skip = 0, take }: { where: Row; skip?: number; take?: number }) =>
      state.fixRuns
        .filter((r) => matches(r, where))
        .sort(
          (a, b) =>
            (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime() ||
            String(b.id).localeCompare(String(a.id)),
        )
        .slice(skip, take === undefined ? undefined : skip + take)
        .map((r) => ({ ...r })),
    deleteMany: async ({ where }: { where: Row }) => {
      const doomed = state.fixRuns.filter((r) => matches(r, where)).map((r) => r.id);
      state.fixRuns = state.fixRuns.filter((r) => !doomed.includes(r.id));
      state.fixItems = state.fixItems.filter((i) => !doomed.includes(i.fixRunId));
      return { count: doomed.length };
    },
  };

  const db = {
    shop: {
      findUnique: async ({ where }: { where: Row }) =>
        state.shops.find((s) => s.id === where.id) ?? null,
    },
    scan: {
      findFirst: async ({ where }: { where: Row }) => {
        const rows = state.scans
          .filter((s) => matches(s, where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
        return rows[0] ?? null;
      },
    },
    finding: {
      findMany: async ({ where }: { where: Row }) =>
        state.findings.filter((f) => matches(f, where)),
    },
    fixRun,
    fixItem,
    $executeRaw: lockFor([]),
    $transaction: async (arg: unknown): Promise<unknown> => {
      if (Array.isArray(arg)) return Promise.all(arg);
      const releases: Array<() => void> = [];
      const tx = { ...db, $executeRaw: lockFor(releases) };
      try {
        return await (arg as (t: unknown) => Promise<unknown>)(tx);
      } finally {
        releases.forEach((r) => r());
      }
    },
  };

  /** pg_advisory_xact_lock: held until the owning transaction ends. */
  function lockFor(releases: Array<() => void>) {
    return async (strings: TemplateStringsArray, ...values: unknown[]) => {
      state.lockSql.push(strings.join("?"));
      const key = String(values[0]);
      while (locks.has(key)) await locks.get(key);
      let release!: () => void;
      locks.set(
        key,
        new Promise<void>((r) => {
          release = r;
        }),
      );
      releases.push(() => {
        locks.delete(key);
        release();
      });
      return 1;
    };
  }

  return { db, state };
}

export type FakeDb = ReturnType<typeof createFakeDb>;

// ---------------------------------------------------------------------------
// Fake Shopify Admin GraphQL
// ---------------------------------------------------------------------------

export type FakeTheme = {
  id: string;
  name: string;
  role: string;
  processing: boolean;
  processingFailed: boolean;
  updatedAt: string;
  files: Map<string, string>;
};

type Json = Record<string, unknown>;
export type Override = (variables: Json) => Json | Error | undefined;

export class FakeShopify {
  themes = new Map<string, FakeTheme>();
  calls: Array<{ op: string; variables: Json }> = [];
  /** Per-operation override: return a full response body, or an Error to throw. */
  overrides: Partial<Record<string, Override>> = {};
  /** Theme checks that still report processing after a duplicate. */
  processingChecks = 0;
  /** Duplicate ends in processingFailed. */
  duplicateFails = false;
  /** Job polls before done (0 = done at once). */
  jobPollsUntilDone = 0;
  /** checksumMd5 overrides: themeId:filename -> checksum. */
  checksumOverride = new Map<string, string>();
  /** Applied to the content an upsert stores (simulate Shopify reformatting). */
  upsertTransform: ((filename: string, content: string) => string) | null = null;
  /** currentAppInstallation.accessScopes handles. */
  grantedScopes: string[] = ["read_themes", "write_themes"];
  /** userErrors returned WITH the job by the next upserts (files still applied). */
  upsertUserErrors: Array<{ code: string; filename: string | null; message: string }> = [];
  /** Files named here are NOT applied by an upsert (Shopify rejected them). */
  upsertRejects = new Set<string>();
  /** Called on every job poll (e.g. the merchant publishes the copy mid-write). */
  onJobPoll: (() => void) | null = null;
  private seq = 100;
  private jobPolls = 0;

  constructor(mainId: string, files: Record<string, string>) {
    this.themes.set(mainId, {
      id: mainId,
      name: "Dawn",
      role: "MAIN",
      processing: false,
      processingFailed: false,
      updatedAt: "2026-11-10T10:00:00Z",
      files: new Map(Object.entries(files)),
    });
  }

  mutationTargets(): string[] {
    return this.calls
      .filter((c) => c.op === "CleanCopyUpsert")
      .map((c) => String(c.variables.themeId));
  }

  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private themeNode(t: FakeTheme) {
    return {
      id: t.id,
      name: t.name,
      role: t.role,
      processing: t.processing,
      processingFailed: t.processingFailed,
      updatedAt: t.updatedAt,
    };
  }

  checksum(themeId: string, filename: string): string | null {
    const t = this.themes.get(themeId);
    const body = t?.files.get(filename);
    if (body === undefined) return null;
    return this.checksumOverride.get(`${themeId}:${filename}`) ?? md5(body);
  }

  graphql = async (query: string, options?: { variables?: Json }) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
    const variables = options?.variables ?? {};
    this.calls.push({ op, variables });
    const override = this.overrides[op]?.(variables);
    if (override instanceof Error) throw override;
    const body = override ?? this.handle(op, variables);
    return { json: async () => body };
  };

  private handle(op: string, v: Json): Json {
    switch (op) {
      case "CleanCopyMain": {
        const main = [...this.themes.values()].find((t) => t.role === "MAIN");
        return { data: { themes: { nodes: main ? [this.themeNode(main)] : [] } } };
      }
      case "CleanCopyTheme": {
        const t = this.themes.get(String(v.id));
        if (t && t.role === "UNPUBLISHED" && t.processing) {
          if (this.processingChecks > 0) {
            this.processingChecks--;
          } else {
            t.processing = false;
            t.processingFailed = this.duplicateFails;
          }
        }
        return { data: { theme: t ? this.themeNode(t) : null } };
      }
      case "CleanCopyThemesByName": {
        const names = (v.names as string[]) ?? [];
        const nodes = [...this.themes.values()]
          .filter((t) => t.role === "UNPUBLISHED" && names.includes(t.name))
          .map((t) => this.themeNode(t));
        return { data: { themes: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      case "CleanCopyDuplicate": {
        const src = this.themes.get(String(v.id));
        if (!src) {
          return {
            data: {
              themeDuplicate: {
                newTheme: null,
                userErrors: [{ code: "NOT_FOUND", field: ["id"], message: "no theme" }],
              },
            },
          };
        }
        const id = `gid://shopify/OnlineStoreTheme/${++this.seq}`;
        const copy: FakeTheme = {
          id,
          name: String(v.name),
          role: "UNPUBLISHED",
          processing: true,
          processingFailed: false,
          updatedAt: "2026-11-10T12:30:00Z",
          files: new Map(src.files),
        };
        this.themes.set(id, copy);
        return { data: { themeDuplicate: { newTheme: this.themeNode(copy), userErrors: [] } } };
      }
      case "CleanCopyFiles": {
        const t = this.themes.get(String(v.id));
        if (!t) return { data: { theme: null } };
        const nodes = ((v.filenames as string[]) ?? [])
          .filter((f) => t.files.has(f))
          .map((f) => ({
            filename: f,
            checksumMd5: this.checksum(t.id, f),
            body: { content: t.files.get(f) },
          }));
        return { data: { theme: { files: { nodes } } } };
      }
      case "CleanCopyUpsert": {
        const t = this.themes.get(String(v.themeId));
        for (const f of (v.files as Array<{ filename: string; body: { value: string } }>) ?? []) {
          if (this.upsertRejects.has(f.filename)) continue;
          const content = this.upsertTransform
            ? this.upsertTransform(f.filename, f.body.value)
            : f.body.value;
          t?.files.set(f.filename, content);
          this.checksumOverride.delete(`${t?.id}:${f.filename}`);
        }
        this.jobPolls = 0;
        return {
          data: {
            themeFilesUpsert: {
              job: { id: "gid://shopify/Job/1", done: this.jobPollsUntilDone === 0 },
              upsertedThemeFiles: [],
              userErrors: this.upsertUserErrors.map((e) => ({ ...e, field: ["files"] })),
            },
          },
        };
      }
      case "CleanCopyScopes":
        return {
          data: {
            currentAppInstallation: {
              accessScopes: this.grantedScopes.map((handle) => ({ handle })),
            },
          },
        };
      case "CleanCopyJob": {
        this.jobPolls++;
        this.onJobPoll?.();
        return { data: { job: { id: v.id, done: this.jobPolls >= this.jobPollsUntilDone } } };
      }
      default:
        throw new Error(`FakeShopify: unexpected operation ${op}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export const MAIN_ID = "gid://shopify/OnlineStoreTheme/1";
export const SHOP_ID = "shop-1";
export const SCAN_ID = "scan-1";

export const SCRIPT_TAG = '<script src="https://cdn.ghostapp.example/widget.js"></script>';
export const LINK_TAG = '<link rel="stylesheet" href="https://cdn.ghostapp.example/w.css">';
export const RENDER_TAG = "{% render 'ghost-widget', product: product %}";

/** A unique substring of the live theme's code: must never leave the process. */
export const BODY_MARKER = "SECRET_BODY_MARKER_7f3a";

export const THEME_FILES: Record<string, string> = {
  "layout/theme.liquid": [
    "<html>",
    "<head>",
    `  <!-- ${BODY_MARKER} -->`,
    `  ${SCRIPT_TAG}`,
    "  <title>{{ shop.name }}</title>",
    `  ${SCRIPT_TAG}`,
    "</head>",
    "<body>{{ content_for_layout }}</body>",
    "</html>",
    "",
  ].join("\n"),
  "sections/header.liquid": [
    `<div class="h">${BODY_MARKER}</div>`,
    `  ${LINK_TAG}`,
    `  ${RENDER_TAG}`,
    "",
  ].join("\n"),
  "snippets/other.liquid": `<p>${BODY_MARKER}</p>\n  ${SCRIPT_TAG}\n`,
};

/** Span of the nth occurrence (0-based) of `needle` in `file`. */
export function spanOf(filename: string, needle: string, nth = 0) {
  const content = THEME_FILES[filename];
  let at = -1;
  for (let i = 0; i <= nth; i++) at = content.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`fixture: ${needle} #${nth} not in ${filename}`);
  const end = at + needle.length;
  return { spanStart: at, spanEnd: end, spanSha256: sha256(content.slice(at, end)) };
}

export type FindingFixture = {
  id: string;
  scanId: string;
  filename: string;
  lineNumber: number;
  codeSnippet: string;
  findingType: string;
  appName: string | null;
  spanStart: number | null;
  spanEnd: number | null;
  spanSha256: string | null;
};

export function finding(
  id: string,
  filename: string,
  type: string,
  needle: string,
  nth = 0,
  over: Partial<FindingFixture> = {},
): FindingFixture {
  return {
    id,
    scanId: SCAN_ID,
    filename,
    lineNumber: 4 + nth,
    codeSnippet: `${needle} #${nth}`,
    findingType: type,
    appName: "Ghost App",
    ...spanOf(filename, needle, nth),
    ...over,
  };
}

export const DEFAULT_FINDINGS: FindingFixture[] = [
  finding("f-script-1", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG, 0),
  finding("f-script-2", "layout/theme.liquid", "GHOST_SCRIPT", SCRIPT_TAG, 1),
  finding("f-link", "sections/header.liquid", "GHOST_STYLE", LINK_TAG),
  finding("f-render", "sections/header.liquid", "GHOST_SNIPPET", RENDER_TAG),
  finding("f-other", "snippets/other.liquid", "GHOST_SCRIPT", SCRIPT_TAG),
];

export function seed(fake: FakeDb, findings: FindingFixture[] = DEFAULT_FINDINGS) {
  fake.state.shops.push({
    id: SHOP_ID,
    domain: "shop-1.myshopify.com",
    plan: "Professional",
    lastThemePublishAt: null,
  });
  fake.state.scans.push({
    id: SCAN_ID,
    shopId: SHOP_ID,
    themeId: MAIN_ID,
    status: "COMPLETED",
    createdAt: new Date("2026-11-10T10:30:00Z"),
    completedAt: new Date("2026-11-10T11:00:00Z"),
    liveAppHooks: { embedApps: ["Live Embed App"], scriptTagApps: null },
  });
  fake.state.findings.push(...findings);
}

/** The scan manifest for the fixture theme ([path, md5, size, updatedAt, owner]). */
export function manifestFor(files: Record<string, string> = THEME_FILES) {
  return {
    scanId: SCAN_ID,
    themeId: MAIN_ID,
    createdAt: new Date("2026-11-10T11:00:00Z"),
    entries: Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, body]) => [path, md5(body), body.length, null, null]),
  };
}
