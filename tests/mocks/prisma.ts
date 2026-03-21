import { vi } from "vitest";

// Create a mock that satisfies the PrismaClient interface.
// Each model gets mock methods: findUnique, findFirst, findMany, create, createMany,
// update, updateMany, delete, deleteMany, count, groupBy, upsert.
export function createMockPrismaClient(): Record<string, unknown> {
  const modelMethods = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    upsert: vi.fn(),
  };

  return {
    session: { ...modelMethods },
    shop: { ...modelMethods },
    scan: { ...modelMethods },
    finding: { ...modelMethods },
    installedApp: { ...modelMethods },
    permissionSnapshot: { ...modelMethods },
    permissionAuditRun: { ...modelMethods },
    $transaction: vi.fn((fn) =>
      fn({
        session: { ...modelMethods },
        shop: { ...modelMethods },
        scan: { ...modelMethods },
        finding: { ...modelMethods },
        installedApp: { ...modelMethods },
        permissionSnapshot: { ...modelMethods },
        permissionAuditRun: { ...modelMethods },
      }),
    ),
  };
}
