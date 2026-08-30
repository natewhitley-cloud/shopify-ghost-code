// GUARD: Local `vitest` runs load `.env` via Vite, so `process.env.DATABASE_URL`
// points at the PRODUCTION Railway DB. `app/db.server.ts` builds `new PrismaClient()`
// at import time from that env, and integration/service tests exercise fire-and-forget
// observability writes (recordWebhookFailure/recordApiError -> db.opsEvent.create) that
// are intentionally NOT mocked. On 2026-08-29 a local run leaked 45 fixture rows into prod.
// This setupFile runs before any test imports `app/db.server.ts`, so unconditionally
// pinning DATABASE_URL to a non-routable dummy here seals the app off from prod during tests.
// (ESM `import` below hoists above this block — harmless, since `vitest` never touches the DB.)
const REMOTE_DB_URL = process.env.DATABASE_URL;

function isRemoteHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    if (!hostname) return false;
    return !["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

const wasRemote = isRemoteHost(REMOTE_DB_URL);

// Unconditionally override — never let tests reach a real DB.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/ghost_code_test";

if (wasRemote) {
  console.warn(
    "[tests/setup] DATABASE_URL pointed at a REMOTE/prod database and was overridden " +
      "to a non-routable local dummy (postgresql://test:test@127.0.0.1:1/ghost_code_test). " +
      "Unmocked opsEvent writes would otherwise leak into prod. " +
      "Create a .env.test with a real local test DB if you need one.",
  );
}

import { vi } from "vitest";

// Silence console.log in tests unless debugging
vi.spyOn(console, "log").mockImplementation(() => {});
