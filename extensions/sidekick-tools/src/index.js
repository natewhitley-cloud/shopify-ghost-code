// Sidekick data tools (gc-5nok). Each tool fetches a relative path on the
// app's own domain; Shopify attaches the merchant's session token
// automatically. The backend routes are app/routes/api.sidekick.*.ts.
// Read-only: no tool removes code, runs a scan or starts a speed test.

const UNAVAILABLE = {
  results: [
    {
      status: "error",
      message: "GhostCode could not read this data right now.",
    },
  ],
};

/**
 * Fetch a tool backend. A non-200 (a 401 has an empty body, a 500 may be
 * HTML), a 200 that is not JSON (a page the auth library renders when no
 * session token arrives), a JSON body without a `results` list, or a network
 * failure returns a short factual error instead of throwing.
 */
export async function fetchTool(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) return UNAVAILABLE;
    const body = await response.json();
    return Array.isArray(body?.results) ? body : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export default async function extension() {
  shopify.tools.register("get_latest_scan_summary", () =>
    fetchTool("/api/sidekick/latest-scan"),
  );

  shopify.tools.register("get_speed_summary", () =>
    fetchTool("/api/sidekick/speed"),
  );
}
