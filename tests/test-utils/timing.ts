/**
 * Shared min-of-two timing helpers for perf-regression tests.
 *
 * A single wall-clock sample measures machine contention under full-suite
 * parallelism / a loaded CI runner, not the code under test — see commit
 * 4a2c3ed, where a single-shot 3 s budget flaked at 7.7 s under load even
 * though the scan takes well under a second in isolation. Running the
 * operation twice and bounding the MIN of the two samples discards a
 * transient stall while still catching a real (e.g. quadratic) regression,
 * which would make both runs slow.
 */

/** Perf-only: runs `fn` twice, discards the return value, returns the min elapsed ms. */
export function timedMinMs(fn: () => void): number {
  const start0 = performance.now();
  fn();
  const elapsed0 = performance.now() - start0;

  const start1 = performance.now();
  fn();
  const elapsed1 = performance.now() - start1;

  return Math.min(elapsed0, elapsed1);
}

/**
 * Runs `fn` twice, keeping the FIRST run's return value for correctness
 * assertions, and returns the min of the two elapsed times.
 */
export function timedMinMsWithResult<T>(fn: () => T): { result: T; minMs: number } {
  const start0 = performance.now();
  const result = fn();
  const elapsed0 = performance.now() - start0;

  const start1 = performance.now();
  fn();
  const elapsed1 = performance.now() - start1;

  return { result, minMs: Math.min(elapsed0, elapsed1) };
}
