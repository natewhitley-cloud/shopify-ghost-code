/**
 * Bound on the values in one SQL `IN (...)` list or one createMany (wave 4
 * H1): Postgres takes at most 32,767 bind parameters per statement, and a
 * list past it fails the whole query.
 */
export const DB_CHUNK_SIZE = 1000;

/** `items` in consecutive slices of at most `size` (none when empty). */
export function chunks<T>(items: readonly T[], size: number = DB_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
