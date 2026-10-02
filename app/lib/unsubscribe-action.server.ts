import {
  renderDonePage,
  renderErrorPage,
  renderInvalidPage,
  UNSUBSCRIBE_HEADERS,
} from "./unsubscribe-page";
import { disableAlertsByToken } from "../models/merchant-alert.server";

/** Shared by the two public unsubscribe resource routes (gc-syz.7, gc-252x). */

export function htmlResponse(
  body: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...UNSUBSCRIBE_HEADERS, ...extraHeaders } });
}

/** Max body size read for the token field: a token is 43 chars; anything big is junk. */
const MAX_BODY_BYTES = 2048;

/** The token a browser form POSTed in the BODY, or "" (unreadable or absent). */
async function readBodyToken(request: Request): Promise<string> {
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return "";
    const value = (await request.formData()).get("token");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * POST handler for both routes. `pathToken` is the /unsubscribe/:token segment
 * (RFC 8058 mail-provider POST); a body `token` field (the confirm page's form)
 * wins when present. Disabling rotates the token (see disableAlertsByToken).
 */
export async function handleUnsubscribePost(
  request: Request,
  pathToken: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return htmlResponse(renderInvalidPage(), 405, { Allow: "GET, HEAD, POST" });
  }
  try {
    const token = (await readBodyToken(request)) || pathToken;
    const disabled = await disableAlertsByToken(token);
    return disabled ? htmlResponse(renderDonePage()) : htmlResponse(renderInvalidPage(), 404);
  } catch {
    // No token or error detail is logged or rendered; handleError is bypassed on
    // purpose because it would record the request URL (which may contain the token).
    return htmlResponse(renderErrorPage(), 500);
  }
}
