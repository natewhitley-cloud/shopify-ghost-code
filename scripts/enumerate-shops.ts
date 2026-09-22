// READ-ONLY spike: enumerate every Shop row to reconcile the digest "active install" count.
// Run: npx tsx --env-file=<your-prod-env-file> scripts/enumerate-shops.ts
// No writes. Safe against prod. (Needs DATABASE_URL pointing at prod in the env file.)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function fmt(d: Date | null) {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "—";
}

async function main() {
  const shops = await prisma.shop.findMany({
    orderBy: [{ uninstalledAt: "asc" }, { installedAt: "asc" }],
    select: {
      id: true,
      domain: true,
      plan: true,
      installedAt: true,
      uninstalledAt: true,
      planReconciledAt: true,
      _count: { select: { scans: true } },
    },
  });

  const active = shops.filter((s) => s.uninstalledAt === null);
  const uninstalled = shops.filter((s) => s.uninstalledAt !== null);

  console.log(`\n=== ALL SHOPS (${shops.length}) ===`);
  console.log(
    `ACTIVE (uninstalledAt=null): ${active.length}   |   UNINSTALLED: ${uninstalled.length}\n`,
  );

  const row = (s: (typeof shops)[number]) =>
    `  ${s.domain.padEnd(38)} plan=${String(s.plan).padEnd(12)} scans=${String(
      s._count.scans,
    ).padStart(3)}  installed=${fmt(s.installedAt)}  uninstalled=${fmt(
      s.uninstalledAt,
    )}  reconciled=${fmt(s.planReconciledAt)}`;

  console.log(`--- ACTIVE (${active.length}) — this is the digest's "Total active" ---`);
  for (const s of active) console.log(row(s));

  console.log(`\n--- UNINSTALLED (${uninstalled.length}) ---`);
  for (const s of uninstalled) console.log(row(s));

  // Plan mix among ACTIVE (what the digest reports)
  const mix = active.reduce<Record<string, number>>((acc, s) => {
    acc[s.plan] = (acc[s.plan] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n--- ACTIVE plan mix (digest basis) ---`);
  console.log("  " + JSON.stringify(mix));

  // Dormant among active (0 scans ever) — candidate phantoms
  const dormant = active.filter((s) => s._count.scans === 0);
  console.log(`\n--- ACTIVE but 0 scans ever (${dormant.length}) — phantom candidates ---`);
  for (const s of dormant) console.log(row(s));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
