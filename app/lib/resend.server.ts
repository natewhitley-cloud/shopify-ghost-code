/**
 * The one Resend send call (gc-v5p7), shared by ops-alert, merchant-alert and
 * support-email. Each caller keeps its own config checks, logging, retry and
 * failure records; this only builds the request. Rejects on network error or
 * timeout (callers catch); never logs, so it can never log a recipient.
 */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_SEND_TIMEOUT_MS = 5000;

export function postResendEmail(
  apiKey: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  // Drop any caller header that names auth or content type in any case, so
  // it cannot sit beside ours (audit L2).
  const extra = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !["authorization", "content-type"].includes(name.toLowerCase()),
    ),
  );
  return fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      ...extra,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(RESEND_SEND_TIMEOUT_MS),
  });
}
