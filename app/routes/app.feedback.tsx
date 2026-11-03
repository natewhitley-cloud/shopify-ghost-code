/**
 * /app/feedback was folded into the Help page (gc-3twe). Old bookmarks and
 * cached nudge links land here (gc-7f1p): redirect to the Help page's
 * feedback topic, keeping every query param (`src=nudge` still counts the
 * nudge click there, and the embedded-app params survive the hop).
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  params.set("topic", "feedback");
  return redirect(`/app/help?${params.toString()}`);
};
