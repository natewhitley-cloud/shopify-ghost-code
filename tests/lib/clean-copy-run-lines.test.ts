/**
 * gc-tib.20: the lines on the scan and select pages that link back to a clean
 * copy's result page, so a merchant who left the page (above all with a
 * "don't publish" copy) can get back to it.
 */
import { describe, expect, it } from "vitest";

import { CANVAS_THEME_HINT } from "../../app/lib/canvas-theme";
import {
  cleanCopyRunLines,
  cleanCopyRunPath,
  type RecentCleanCopyRun,
  RUN_REFUSAL_REASONS,
  runRefusalCopy,
} from "../../app/lib/clean-copy-view";

const run = (over: Partial<RecentCleanCopyRun> = {}): RecentCleanCopyRun => ({
  id: "run-1",
  status: "completed",
  doNotPublish: false,
  failureReason: null,
  copyThemeId: "gid://shopify/OnlineStoreTheme/2",
  copyThemeName: "Dawn - clean copy ab12",
  ...over,
});

describe("cleanCopyRunLines: the newest run", () => {
  it("no runs: no lines", () => {
    expect(cleanCopyRunLines([])).toEqual([]);
  });

  it("completed: a quiet line naming the copy", () => {
    expect(cleanCopyRunLines([run()])).toEqual([
      {
        runId: "run-1",
        tone: "info",
        text: 'Your last clean copy, "Dawn - clean copy ab12", is finished.',
      },
    ]);
  });

  it("completed without a saved copy name: no empty quotes", () => {
    const [line] = cleanCopyRunLines([run({ copyThemeName: null })]);
    expect(line.text).toBe("Your last clean copy is finished.");
  });

  it("partial: says some code was left in", () => {
    const [line] = cleanCopyRunLines([run({ status: "partial" })]);
    expect(line).toMatchObject({ tone: "info" });
    expect(line.text).toBe(
      'Your last clean copy, "Dawn - clean copy ab12", is finished, with some code left in.',
    );
  });

  it("failed (including a stale run read as failed): a warning", () => {
    for (const failureReason of ["SCAN_STALE", "STALE", null]) {
      const [line] = cleanCopyRunLines([run({ status: "failed", failureReason })]);
      expect(line).toEqual({
        runId: "run-1",
        tone: "warning",
        text: "Your last clean copy didn't finish.",
      });
    }
  });

  it("active: in progress, for every active status", () => {
    for (const status of ["pending", "duplicating", "writing"]) {
      const [line] = cleanCopyRunLines([run({ status, copyThemeId: null })]);
      expect(line).toMatchObject({ tone: "info", text: "Your clean copy is in progress." });
    }
  });

  it("an unknown status: a neutral line, never 'finished'", () => {
    const [line] = cleanCopyRunLines([run({ status: "mystery" })]);
    expect(line).toMatchObject({ tone: "info", text: "See how your last clean copy went." });
  });

  it("do-not-publish: a critical warning naming the copy, with no live-theme claim", () => {
    const [line] = cleanCopyRunLines([
      run({ status: "failed", doNotPublish: true, failureReason: "VERIFY_FAILED" }),
    ]);
    expect(line.tone).toBe("critical");
    expect(line.text).toBe(
      "We couldn't confirm every change in the copy \"Dawn - clean copy ab12\". Don't publish it. If you already did, publish your previous theme again.",
    );
    expect(line.text).not.toMatch(/live theme was not changed/i);
  });

  it("do-not-publish while still active (flag set mid-run): the warning wins", () => {
    const [line] = cleanCopyRunLines([run({ status: "writing", doNotPublish: true })]);
    expect(line.tone).toBe("critical");
  });

  it("copy published during the write: critical even without the flag", () => {
    const [line] = cleanCopyRunLines([
      run({ status: "failed", failureReason: "COPY_PUBLISHED_DURING_WRITE" }),
    ]);
    expect(line.tone).toBe("critical");
  });

  it("do-not-publish without a name: 'this clean copy'", () => {
    const [line] = cleanCopyRunLines([run({ doNotPublish: true, copyThemeName: null })]);
    expect(line.text).toContain("every change in this clean copy.");
  });

  it("no warning when the copy is gone (COPY_MISSING) or was never made", () => {
    const gone = run({ status: "failed", doNotPublish: true, failureReason: "COPY_MISSING" });
    const never = run({ status: "failed", doNotPublish: true, copyThemeId: null });
    for (const r of [gone, never]) {
      const [line] = cleanCopyRunLines([r]);
      expect(line.tone).toBe("warning");
      expect(line.text).toBe("Your last clean copy didn't finish.");
    }
  });
});

describe("cleanCopyRunLines: an older unsafe copy stays visible", () => {
  it("a newer finished run does not hide an older do-not-publish copy; the warning comes first", () => {
    const older = run({ id: "run-old", status: "failed", doNotPublish: true });
    const lines = cleanCopyRunLines([run({ id: "run-new" }), older]);
    expect(lines.map((l) => [l.runId, l.tone])).toEqual([
      ["run-old", "critical"],
      ["run-new", "info"],
    ]);
  });

  it("only the newest older unsafe copy is shown (at most two lines)", () => {
    const lines = cleanCopyRunLines([
      run({ id: "a" }),
      run({ id: "b", doNotPublish: true }),
      run({ id: "c", doNotPublish: true }),
    ]);
    expect(lines.map((l) => l.runId)).toEqual(["b", "a"]);
  });

  it("the newest run unsafe and an older one unsafe: both, two different copies", () => {
    const lines = cleanCopyRunLines([
      run({ id: "a", doNotPublish: true }),
      run({ id: "b", doNotPublish: true }),
    ]);
    expect(lines.map((l) => [l.runId, l.tone])).toEqual([
      ["b", "critical"],
      ["a", "critical"],
    ]);
  });

  it("older safe runs add nothing", () => {
    const lines = cleanCopyRunLines([
      run({ id: "a" }),
      run({ id: "b", status: "failed" }),
      run({ id: "c", status: "failed", doNotPublish: true, failureReason: "COPY_MISSING" }),
    ]);
    expect(lines.map((l) => l.runId)).toEqual(["a"]);
  });
});

describe("cleanCopyRunPath", () => {
  it("is the result page, with the id encoded", () => {
    expect(cleanCopyRunPath("run-1")).toBe("/app/clean-copy/run-1");
    expect(cleanCopyRunPath("a/b?c")).toBe("/app/clean-copy/a%2Fb%3Fc");
  });
});

describe("gc-tib.12: the Canvas hint where we can't find the live theme", () => {
  it("the clean copy NO_MAIN_THEME refusal names Canvas as a likely reason", () => {
    expect(runRefusalCopy("NO_MAIN_THEME")).toBe(
      "We couldn't find your live theme. Check Online Store > Themes and try again. If you edit your theme with Canvas, GhostCode can't read it yet.",
    );
  });

  it("the hint itself (the scan's no-published-theme error is checked in app._index.test.ts)", () => {
    expect(CANVAS_THEME_HINT).toBe(
      "If you edit your theme with Canvas, GhostCode can't read it yet.",
    );
  });

  it("no other refusal mentions Canvas (the hint is not a general excuse)", () => {
    for (const reason of RUN_REFUSAL_REASONS.filter(
      (r) => r !== "NO_MAIN_THEME" && !r.includes("CANVAS"),
    )) {
      expect(runRefusalCopy(reason)).not.toContain("Canvas");
    }
  });
});
