import type { Config } from "@react-router/dev/config";

export default {
  // React Router 7.18 tightened the action-origin CSRF check: it now compares the
  // browser's `Origin` header against the origin of `request.url` instead of the
  // forwarded Host header. Behind Railway's TLS-terminating proxy, react-router-serve
  // runs a bare express app with no `trust proxy`, so `request.url` is built with an
  // `http` scheme while the embedded-admin `Origin` is `https://app.alpenglowsoftware.com`.
  // The origins mismatch, and without an allowlist every UI-route action (a `<Form>` /
  // `useFetcher` POST — e.g. triggering a scan, saving settings) would be rejected with a
  // CSRF error. Allowlisting the app's public host (matched against the Origin header's
  // host, scheme-agnostic) accepts those legitimate same-origin mutations. (gc-06e.4)
  //
  // DEPLOY-VERIFY REQUIRED: this cannot be exercised locally (dev origins match, so the
  // fallback allowlist is never consulted). On the first real deploy, confirm a browser
  // mutation succeeds (trigger a scan or save settings) before considering this closed.
  allowedActionOrigins: ["app.alpenglowsoftware.com"],
} satisfies Config;
