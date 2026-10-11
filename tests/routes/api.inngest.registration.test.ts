/**
 * Every Inngest function the app defines must be served, or Inngest never
 * runs it. Pins the store speed report functions (gc-wt3y) in the serve list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const SOURCE = readFileSync(join(__dirname, "..", "..", "app/routes/api.inngest.ts"), "utf8");
const FUNCTIONS = SOURCE.slice(SOURCE.indexOf("functions: ["), SOURCE.indexOf("],"));

describe("api.inngest serve list", () => {
  it.each(["speedReportWeekly", "speedReportRun", "speedReportCancelled"])(
    "registers %s",
    (name) => {
      expect(SOURCE).toMatch(
        /import \{[^}]*\bspeedReportCancelled\b[^}]*\bspeedReportRun\b[^}]*\bspeedReportWeekly\b[^}]*\} from "\.\.\/\.\.\/inngest\/functions\/speed-report";/,
      );
      expect(FUNCTIONS).toMatch(new RegExp(`\\b${name},`));
    },
  );
});
