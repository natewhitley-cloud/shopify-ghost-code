/**
 * gc-tib batch audit regressions for the Clean copy view model (H2, M-a,
 * M-d, M-g, logic 16).
 */
import { describe, expect, it } from "vitest";

import {
  candidateBlockCopy,
  fixItemReasonCopy,
  LIVE_THEME_CHANGED_COPY,
  liveThemeNotice,
  liveThemeState,
  PUBLISHED_COPY_COPY,
  RUN_REFUSAL_REASONS,
  runRefusalCopy,
  runSummary,
} from "../../app/lib/clean-copy-view";

const GENERIC = runRefusalCopy("SOMETHING_UNKNOWN");

describe("M-g: specific copy for worker failures", () => {
  it.each([
    "NOTHING_REMOVED",
    "INCOMPLETE",
    "INTERNAL_ERROR",
    "DUPLICATE_FAILED",
    "COPY_PUBLISHED_DURING_WRITE",
    "CANVAS_THEME",
  ])("%s is in RUN_REFUSAL_REASONS with its own copy", (reason) => {
    expect(RUN_REFUSAL_REASONS).toContain(reason);
    expect(runRefusalCopy(reason)).not.toBe(GENERIC);
  });

  it("the exact strings the audit asked for", () => {
    expect(runRefusalCopy("CANVAS_THEME")).toBe("Clean copy doesn't support Canvas themes yet.");
    expect(runRefusalCopy("DUPLICATE_FAILED")).toContain("theme limit");
    expect(runRefusalCopy("DUPLICATE_FAILED")).toContain("Delete themes you don't use");
    expect(runRefusalCopy("NOTHING_REMOVED")).toContain("run a new scan");
  });

  it("an item failed because the copy was published gets its own line", () => {
    expect(fixItemReasonCopy("COPY_PUBLISHED_DURING_WRITE")).toBe(
      "Not confirmed. The copy was published before we could check this change.",
    );
  });
});

describe("logic 16: NO_SPAN copy covers commented-out code", () => {
  it("does not claim we can't find where it starts", () => {
    expect(candidateBlockCopy("NO_SPAN")).toBe(
      "We can't remove this one automatically. It may be commented out, or its start and end aren't clear.",
    );
  });
});

describe("runSummary audit cases", () => {
  const items = [{ status: "pending" }];

  it("M-a: an active run says not to publish yet", () => {
    expect(
      runSummary({ status: "writing", doNotPublish: false, failureReason: null, items }).body,
    ).toContain("Don't publish the copy until this finishes.");
  });

  it("M-a: a copy published mid-write is critical and never says the live theme is unchanged", () => {
    const s = runSummary({
      status: "failed",
      doNotPublish: true,
      failureReason: "COPY_PUBLISHED_DURING_WRITE",
      items,
      hasCopy: true,
    });
    expect(s.tone).toBe("critical");
    expect(s.showPreview).toBe(false);
    expect(s.body).not.toContain("Your live theme was not changed.");
    expect(s.body).toContain("Publish your previous theme again");
  });

  it("M-d: a failed run with a copy says to delete it; without one it does not", () => {
    const base = { status: "failed", doNotPublish: false, failureReason: "INTERNAL_ERROR", items };
    expect(runSummary({ ...base, hasCopy: true }).body).toContain(
      "Delete it from Online Store > Themes before you try again.",
    );
    expect(runSummary({ ...base, hasCopy: false }).body).not.toContain("Delete it");
  });
});

describe("H2: liveThemeState / liveThemeNotice", () => {
  const base = {
    mainId: "src",
    mainUpdatedAt: new Date("2026-11-10T11:00:00Z"),
    sourceThemeId: "src",
    copyThemeId: "copy",
    copyCreatedAt: new Date("2026-11-10T12:00:00Z"),
  };

  it("unchanged / changed (edited, other theme) / published_copy", () => {
    expect(liveThemeState(base)).toBe("unchanged");
    expect(liveThemeState({ ...base, mainUpdatedAt: new Date("2026-11-10T12:00:01Z") })).toBe(
      "changed",
    );
    expect(liveThemeState({ ...base, mainId: "other" })).toBe("changed");
    expect(liveThemeState({ ...base, mainId: "copy" })).toBe("published_copy");
    expect(liveThemeState({ ...base, mainUpdatedAt: null, copyCreatedAt: null })).toBe("unchanged");
  });

  it("notices", () => {
    expect(liveThemeNotice("unchanged")).toBeNull();
    expect(liveThemeNotice(null)).toBeNull();
    expect(liveThemeNotice("changed")).toEqual({ tone: "warning", text: LIVE_THEME_CHANGED_COPY });
    expect(liveThemeNotice("published_copy")).toEqual({ tone: "info", text: PUBLISHED_COPY_COPY });
    expect(LIVE_THEME_CHANGED_COPY).toBe(
      "Your live theme changed after this clean copy was made. Make a new copy so you don't lose those changes.",
    );
  });
});
