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
  FAILED_RUN_BANNER_MS,
  type RecentCleanCopyRun,
  RUN_REFUSAL_REASONS,
  runHasCopy,
  runRefusalCopy,
} from "../../app/lib/clean-copy-view";

const run = (over: Partial<RecentCleanCopyRun> = {}): RecentCleanCopyRun => ({
  id: "run-1",
  status: "completed",
  doNotPublish: false,
  failureReason: null,
  copyThemeId: "gid://shopify/OnlineStoreTheme/2",
  copyThemeName: "Dawn - clean copy ab12",
  copyGoneAt: null,
  updatedAt: new Date(),
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
        linkLabel: "View result",
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
        linkLabel: "View result",
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

  it("the newest run unsafe and an older one unsafe: both, newest first", () => {
    const lines = cleanCopyRunLines([
      run({ id: "a", doNotPublish: true }),
      run({ id: "b", doNotPublish: true }),
    ]);
    // r1: the newest warning stays first; the older one follows.
    expect(lines.map((l) => [l.runId, l.tone])).toEqual([
      ["a", "critical"],
      ["b", "critical"],
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

describe("r1: a deleted copy clears its warning; a copy published mid-write says so", () => {
  it("copyGoneAt set: no warning, for the newest run or an older one", () => {
    const gone = new Date("2026-11-11T10:00:00Z");
    const [newest] = cleanCopyRunLines([
      run({ status: "failed", doNotPublish: true, copyGoneAt: gone }),
    ]);
    expect(newest.tone).toBe("warning");
    const lines = cleanCopyRunLines([
      run({ id: "new" }),
      run({ id: "old", doNotPublish: true, copyGoneAt: gone }),
    ]);
    expect(lines.map((l) => l.runId)).toEqual(["new"]);
  });

  it("copyGoneAt also clears the published-mid-write warning", () => {
    const [line] = cleanCopyRunLines([
      run({
        status: "failed",
        failureReason: "COPY_PUBLISHED_DURING_WRITE",
        copyGoneAt: new Date(),
      }),
    ]);
    expect(line.tone).toBe("warning");
  });

  it("published mid-write: says it was published, not 'don't publish it'", () => {
    const [named] = cleanCopyRunLines([
      run({ status: "failed", failureReason: "COPY_PUBLISHED_DURING_WRITE", doNotPublish: true }),
    ]);
    expect(named).toMatchObject({
      tone: "critical",
      text: 'The copy "Dawn - clean copy ab12" was published before we finished removing code. See what to do next.',
    });
    const [unnamed] = cleanCopyRunLines([
      run({ status: "failed", failureReason: "COPY_PUBLISHED_DURING_WRITE", copyThemeName: null }),
    ]);
    expect(unnamed.text).toBe(
      "Your clean copy was published before we finished removing code. See what to do next.",
    );
  });
});

describe("runHasCopy (shared with the result page)", () => {
  it("needs a copy id, no COPY_MISSING and no copyGoneAt", () => {
    const base = { copyThemeId: "gid://shopify/OnlineStoreTheme/2", failureReason: null };
    expect(runHasCopy(base)).toBe(true);
    expect(runHasCopy({ ...base, copyGoneAt: null })).toBe(true);
    expect(runHasCopy({ ...base, copyThemeId: null })).toBe(false);
    expect(runHasCopy({ ...base, failureReason: "COPY_MISSING" })).toBe(false);
    expect(runHasCopy({ ...base, copyGoneAt: new Date() })).toBe(false);
    // Serialized loader data carries the date as a string.
    expect(runHasCopy({ ...base, copyGoneAt: "2026-11-11T10:00:00.000Z" })).toBe(false);
  });
});

describe("gc-e28n: polish", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("a failed run is a warning for 7 days, then a quiet line", () => {
    const line = (updatedAt: Date) =>
      cleanCopyRunLines([run({ status: "failed", updatedAt })], now)[0];
    expect(line(ago(FAILED_RUN_BANNER_MS - 1)).tone).toBe("warning");
    expect(line(ago(FAILED_RUN_BANNER_MS)).tone).toBe("info");
    expect(line(ago(FAILED_RUN_BANNER_MS)).text).toBe("Your last clean copy didn't finish.");
  });

  it("a don't-publish warning never goes quiet with age", () => {
    const [line] = cleanCopyRunLines(
      [run({ status: "failed", doNotPublish: true, updatedAt: ago(90 * 86_400_000) })],
      now,
    );
    expect(line.tone).toBe("critical");
  });

  it("an active run links with 'See progress'; every other line with 'View result'", () => {
    expect(cleanCopyRunLines([run({ status: "writing" })], now)[0].linkLabel).toBe("See progress");
    for (const status of ["completed", "partial", "failed", "mystery"]) {
      expect(cleanCopyRunLines([run({ status })], now)[0].linkLabel).toBe("View result");
    }
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
