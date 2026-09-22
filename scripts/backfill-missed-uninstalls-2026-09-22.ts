// One-time maintenance: backfill uninstalledAt for shops that uninstalled on
// Shopify but whose uninstall webhook was missed (row left uninstalledAt=null).
// Source of truth = Partner Dashboard install/event history (2026-09-22).
// Guarded: only updates rows where uninstalledAt IS NULL (idempotent). Dates are
// from the dashboard (approx local time); exact minute is immaterial for the marker.
// Run: npx tsx --env-file=.env scripts/backfill-missed-uninstalls-2026-09-22.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// domain -> actual uninstall timestamp (from Partner Dashboard)
const PHANTOMS: Array<{ domain: string; uninstalledAt: string; store: string }> = [
  { domain: "teststore22022.myshopify.com", uninstalledAt: "2026-08-27T08:24:00Z", store: "teststore22022 (test)" },
  { domain: "dahi5e-1d.myshopify.com", uninstalledAt: "2026-08-31T11:06:00Z", store: "APPT 4 (test)" },
  { domain: "www-mantrasupplements-co-uk.myshopify.com", uninstalledAt: "2026-09-12T07:16:00Z", store: "Mantra Men's Club (real merchant)" },
  { domain: "app-review-fe7f0c8b-r103004-a3-victim.myshopify.com", uninstalledAt: "2026-09-15T20:50:00Z", store: "Shopify review" },
  { domain: "app-review-fe7f0c8b-r102735-a1-primary.myshopify.com", uninstalledAt: "2026-09-15T21:18:00Z", store: "Shopify review" },
];

function fmt(d: Date | null) {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "—";
}

async function main() {
  console.log("=== BEFORE (current state of the 5 target rows) ===");
  for (const p of PHANTOMS) {
    const row = await prisma.shop.findUnique({
      where: { domain: p.domain },
      select: { domain: true, plan: true, uninstalledAt: true },
    });
    if (!row) {
      console.log(`  MISSING (no such row): ${p.domain}`);
      continue;
    }
    console.log(`  ${p.domain.padEnd(48)} plan=${String(row.plan).padEnd(12)} uninstalledAt=${fmt(row.uninstalledAt)}  [${p.store}]`);
  }

  console.log("\n=== WRITE (only where uninstalledAt IS NULL) ===");
  for (const p of PHANTOMS) {
    const res = await prisma.shop.updateMany({
      where: { domain: p.domain, uninstalledAt: null },
      data: { uninstalledAt: new Date(p.uninstalledAt) },
    });
    console.log(`  ${p.domain.padEnd(48)} rows updated: ${res.count}  -> ${p.uninstalledAt.slice(0, 10)}`);
  }

  console.log("\n=== AFTER ===");
  for (const p of PHANTOMS) {
    const row = await prisma.shop.findUnique({
      where: { domain: p.domain },
      select: { uninstalledAt: true },
    });
    console.log(`  ${p.domain.padEnd(48)} uninstalledAt=${fmt(row?.uninstalledAt ?? null)}`);
  }

  const activeCount = await prisma.shop.count({ where: { uninstalledAt: null } });
  const uninstalledCount = await prisma.shop.count({ where: { uninstalledAt: { not: null } } });
  console.log(`\n=== RESULT: active (uninstalledAt null) = ${activeCount}, uninstalled = ${uninstalledCount} ===`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
