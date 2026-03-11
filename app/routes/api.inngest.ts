/**
 * Inngest serve endpoint — handles all Inngest SDK communication
 * (function registration, event delivery, health checks).
 *
 * React Router v7 uses the same loader/action export pattern as Remix,
 * so the `inngest/remix` adapter is the correct choice here.
 *
 * Local dev: Inngest Dev Server polls this route automatically.
 * Production: Inngest cloud syncs against this endpoint after deploy.
 *
 * TODO(implementer): import each Inngest function from inngest/functions/
 * and add it to the functions array below as they are built.
 */
import { serve } from "inngest/remix";
import { inngest } from "../../inngest/client";

// TODO(implementer): import functions here as they are created, e.g.:
// import { scanRequested } from "../../inngest/functions/scan-requested";

const handler = serve({
  client: inngest,
  functions: [
    // TODO(implementer): add functions here
  ],
});

export { handler as loader, handler as action };
