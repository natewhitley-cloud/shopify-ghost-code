/**
 * Scan wait experience copy and timing (ScanProgress, used by the scan detail
 * page and the home page while a scan is PENDING or IN_PROGRESS).
 *
 * Pure and client-safe. Everything is derived from the seconds elapsed since
 * the scan's createdAt, never from component mount time, so the scan page's 3s
 * loader revalidation (or navigating away and back) never resets or jumps the
 * rotating phrase: the same elapsed time always shows the same phrase.
 *
 * Copy rules (guarded by tests/lib/scan-progress.test.ts): short, no em
 * dashes, never implies findings exist before they do, and never tells the
 * merchant to leave the page or come back.
 */

/** How long each rotating phrase stays on screen. */
export const SCAN_PHRASE_INTERVAL_SECONDS = 7;

/** LONG_SCAN_PHRASES join the rotation only for slots starting at or after this. */
export const LONG_SCAN_AFTER_SECONDS = 60;

/**
 * Every LONG_SCAN_EVERY_N_SLOTS-th slot after the threshold shows a long-scan
 * phrase (starting with the first slot past it); the rest keep cycling
 * SCAN_PHRASES.
 */
const LONG_SCAN_EVERY_N_SLOTS = 3;

/** The general rotation, shown in this order from the moment the scan starts. */
export const SCAN_PHRASES: readonly string[] = [
  "Checking your theme files",
  "Looking for code left behind by old apps",
  "Shining a flashlight into your snippets",
  "Following old app trails",
  "Reading through your theme sections",
  "Checking the attic for leftover scripts",
  "Comparing code with known app signatures",
  "Peeking behind your layout files",
  "Checking stylesheets for stray app styles",
  "Tracing script tags back to their apps",
  "Dusting off older templates",
  "Separating your code from app code",
  "Making steady progress through your theme",
];

/** Extra phrases for a scan still running after LONG_SCAN_AFTER_SECONDS. */
export const LONG_SCAN_PHRASES: readonly string[] = [
  "Bigger themes take a little longer",
  "Still working through your theme",
  "Every file gets a proper look",
];

/** Static expectation line shown under the rotating phrase. */
export const SCAN_DURATION_EXPECTATION = "This usually takes up to a minute or two.";

/** The first slot whose start time is at or after LONG_SCAN_AFTER_SECONDS. */
const FIRST_LONG_SLOT = Math.ceil(LONG_SCAN_AFTER_SECONDS / SCAN_PHRASE_INTERVAL_SECONDS);

/**
 * Seconds since `createdAt` at `nowMs`, never negative (client clock behind
 * the server's) and 0 for an unparseable date.
 */
export function scanElapsedSeconds(createdAt: Date | string, nowMs: number): number {
  const seconds = (nowMs - new Date(createdAt).getTime()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/**
 * The phrase to show `elapsedSeconds` into a scan. Each phrase holds for
 * SCAN_PHRASE_INTERVAL_SECONDS. Before LONG_SCAN_AFTER_SECONDS slot N shows
 * SCAN_PHRASES[N]; from then on every third slot shows the next
 * LONG_SCAN_PHRASES entry and the others continue SCAN_PHRASES by slot number.
 * Two consecutive slots never show the same phrase: base slots N and N+1 map
 * to different indices, and long-scan slots are never adjacent.
 */
export function scanProgressPhrase(elapsedSeconds: number): string {
  const safe = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const slot = Math.floor(safe / SCAN_PHRASE_INTERVAL_SECONDS);
  if (slot >= FIRST_LONG_SLOT) {
    const sinceLong = slot - FIRST_LONG_SLOT;
    if (sinceLong % LONG_SCAN_EVERY_N_SLOTS === 0) {
      return LONG_SCAN_PHRASES[(sinceLong / LONG_SCAN_EVERY_N_SLOTS) % LONG_SCAN_PHRASES.length];
    }
  }
  return SCAN_PHRASES[slot % SCAN_PHRASES.length];
}

/**
 * Live findings-so-far line (gc-rzq), from the partial `findingCount` the scan
 * page re-reads on each 3s poll. Null for 0 (the rotating phrase covers that
 * state, and "Found 0" would read like a completed empty scan). Worded as
 * in-progress ("so far…") so it never reads as a final count.
 */
export function findingsSoFarLabel(findingCount: number): string | null {
  if (findingCount <= 0) return null;
  if (findingCount === 1) return "Found 1 finding so far…";
  return `Found ${findingCount} findings so far…`;
}

/**
 * Format elapsed seconds into a human-readable string.
 * Examples: "a few seconds", "30 seconds", "1 minute", "2 minutes", "3 minutes 15 seconds"
 */
export function formatElapsedTime(elapsedSeconds: number): string {
  if (elapsedSeconds < 10) return "a few seconds";
  if (elapsedSeconds < 60) return `${Math.floor(elapsedSeconds)} seconds`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const remainingSeconds = Math.floor(elapsedSeconds % 60);
  if (minutes === 1 && remainingSeconds === 0) return "1 minute";
  if (minutes === 1) return `1 minute ${remainingSeconds} seconds`;
  if (remainingSeconds === 0) return `${minutes} minutes`;
  return `${minutes} minutes ${remainingSeconds} seconds`;
}
