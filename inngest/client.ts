import { EventSchemas, Inngest } from "inngest";
import type { Events } from "./events";
import { loggingMiddleware } from "./middleware";

export const inngest = new Inngest({
  id: "ghost-code",
  schemas: new EventSchemas().fromRecord<Events>(),
  middleware: [loggingMiddleware],
});
