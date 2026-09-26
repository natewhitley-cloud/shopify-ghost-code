/**
 * A stateful, in-memory Shop row behind mocked `db.shop.updateMany` /
 * `db.shop.findUnique`, for tests of the compare-and-set claims in
 * app/models/shop.server.ts driven through the real services.
 *
 * updateMany applies its data only when EVERY where clause still matches the
 * row at write time (Postgres row-level compare-and-set), and yields to the
 * event loop first, so callers started together with Promise.all read before
 * either writes and genuinely race. Supported where values: plain equality
 * (Dates by time), `null`, `{ not }`, `{ equals }`, `{ gt | gte | lt | lte }`,
 * and `OR` / `AND` arrays. Supported data values: plain values and
 * `{ increment: n }`.
 */
import type { Mock } from "vitest";

export type FakeRow = Record<string, unknown>;

function asTime(v: unknown): number {
  return v instanceof Date ? v.getTime() : (v as number);
}

/** True when `current` satisfies one Prisma where-value (equality or filter). */
function matchesValue(current: unknown, cond: unknown): boolean {
  if (cond instanceof Date) return current instanceof Date && current.getTime() === cond.getTime();
  if (cond !== null && typeof cond === "object") {
    const c = cond as FakeRow;
    if ("not" in c && matchesValue(current, c.not)) return false;
    if ("equals" in c && !matchesValue(current, c.equals)) return false;
    const ranged = "gt" in c || "gte" in c || "lt" in c || "lte" in c;
    if (current === null || current === undefined) return !ranged;
    if ("gt" in c && !(asTime(current) > asTime(c.gt))) return false;
    if ("gte" in c && !(asTime(current) >= asTime(c.gte))) return false;
    if ("lt" in c && !(asTime(current) < asTime(c.lt))) return false;
    if ("lte" in c && !(asTime(current) <= asTime(c.lte))) return false;
    return true;
  }
  return current === cond;
}

export function matchesWhere(row: FakeRow, where: FakeRow): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as FakeRow[]).some((w) => matchesWhere(row, w));
    if (k === "AND") return (v as FakeRow[]).every((w) => matchesWhere(row, w));
    return matchesValue(row[k], v);
  });
}

/**
 * Install the row behind the two mocks and return it (mutated in place by
 * every winning updateMany). findUnique returns a copy.
 */
export function installFakeShopRow(
  mocks: { updateMany: Mock; findUnique?: Mock },
  initial: FakeRow,
): FakeRow {
  const row: FakeRow = { ...initial };
  mocks.updateMany.mockImplementation(
    async ({ where, data }: { where: FakeRow; data: FakeRow }) => {
      await Promise.resolve();
      if (!matchesWhere(row, where)) return { count: 0 };
      for (const [k, v] of Object.entries(data)) {
        if (v !== null && typeof v === "object" && "increment" in (v as FakeRow)) {
          row[k] = (row[k] as number) + ((v as FakeRow).increment as number);
        } else {
          row[k] = v;
        }
      }
      return { count: 1 };
    },
  );
  mocks.findUnique?.mockImplementation(async () => ({ ...row }));
  return row;
}
