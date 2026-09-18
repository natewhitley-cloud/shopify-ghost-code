// READ-ONLY spike: review the most recent new-customer scan(s).
// Run: npx tsx --env-file=.env scripts/review-latest-scan.ts
// No writes. Safe against prod.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function fmt(d: Date | null) {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "—";
}

async function main() {
  // 1. Recently-installed shops (last 3 days)
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const shops = await prisma.shop.findMany({
    where: { installedAt: { gte: since } },
    orderBy: { installedAt: "desc" },
  });
  console.log(`\n=== SHOPS installed since ${fmt(since)} (${shops.length}) ===`);
  for (const s of shops) {
    console.log(
      `  ${s.domain}  plan=${s.plan}  installed=${fmt(s.installedAt)}  uninstalled=${fmt(s.uninstalledAt)}  id=${s.id}`,
    );
  }

  // 2. Recent scans (last 3 days), newest first
  const scans = await prisma.scan.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  console.log(`\n=== SCANS since ${fmt(since)} (${scans.length}) ===`);
  for (const sc of scans) {
    console.log(
      `  ${sc.id}  shop=${sc.shopId}  theme=${sc.themeName}  status=${sc.status}  origin=${sc.origin}\n` +
        `      findings=${sc.findingCount} (new=${sc.newFindingCount} resolved=${sc.resolvedFindingCount} persisted=${sc.persistedFindingCount})` +
        `  skippedCats=[${sc.skippedCategories.join(",")}] skippedFiles=${sc.skippedFiles.length}\n` +
        `      started=${fmt(sc.startedAt)} completed=${fmt(sc.completedAt)} created=${fmt(sc.createdAt)}`,
    );
  }

  if (scans.length === 0) {
    console.log("\nNo recent scans found. Widening or exiting.");
    return;
  }

  // Focus: the scan(s) with the most findings among the recent set
  const focus = [...scans].sort((a, b) => b.findingCount - a.findingCount).slice(0, 2);

  for (const sc of focus) {
    console.log(`\n\n########## DEEP DIVE: scan ${sc.id} (${sc.themeName}, ${sc.findingCount} findings) ##########`);

    // 3. Findings grouped by type / severity / appName
    const findings = await prisma.finding.findMany({ where: { scanId: sc.id } });
    const byType = new Map<string, number>();
    const bySev = new Map<string, number>();
    const byApp = new Map<string, number>();
    for (const f of findings) {
      byType.set(f.findingType, (byType.get(f.findingType) ?? 0) + 1);
      bySev.set(f.severity, (bySev.get(f.severity) ?? 0) + 1);
      const app = f.appName ?? "(none)";
      byApp.set(app, (byApp.get(app) ?? 0) + 1);
    }
    console.log("  -- findings by TYPE --");
    for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${v.toString().padStart(4)}  ${k}`);
    console.log("  -- findings by SEVERITY --");
    for (const [k, v] of [...bySev.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${v.toString().padStart(4)}  ${k}`);
    console.log("  -- findings by APP --");
    for (const [k, v] of [...byApp.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${v.toString().padStart(4)}  ${k}`);

    // 4. ScanDomain graph — matched vs benign vs neither (flywheel candidates)
    const domains = await prisma.scanDomain.findMany({ where: { scanId: sc.id }, orderBy: { refCount: "desc" } });
    console.log(`\n  -- THIRD-PARTY DOMAINS (${domains.length}) --`);
    const matched = domains.filter((d) => d.matched);
    const benign = domains.filter((d) => !d.matched && d.benign);
    const unknown = domains.filter((d) => !d.matched && !d.benign);
    console.log(`     matched=${matched.length}  benign=${benign.length}  UNKNOWN(flywheel candidates)=${unknown.length}`);
    console.log("     matched:");
    for (const d of matched) console.log(`        ${d.domain}  app=${d.appName}  refs=${d.refCount} sources=[${d.sources.join(",")}]`);
    console.log("     benign:");
    for (const d of benign) console.log(`        ${d.domain}  refs=${d.refCount} sources=[${d.sources.join(",")}]`);
    console.log("     UNKNOWN (candidates for new signatures):");
    for (const d of unknown) console.log(`        ${d.domain}  refs=${d.refCount} sources=[${d.sources.join(",")}]`);

    // 5. UnknownScripts for this scan (existing flywheel input)
    const unk = await prisma.unknownScript.findMany({ where: { scanId: sc.id } });
    const unkByDomain = new Map<string, number>();
    for (const u of unk) unkByDomain.set(u.domain ?? "(null)", (unkByDomain.get(u.domain ?? "(null)") ?? 0) + 1);
    console.log(`\n  -- UNKNOWN SCRIPTS (${unk.length}) by domain --`);
    for (const [k, v] of [...unkByDomain.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${v.toString().padStart(4)}  ${k}`);
  }

  // 6. scan_signal OpsEvents for the recent window (telemetry histogram)
  const signals = await prisma.opsEvent.findMany({
    where: { eventType: "scan_signal", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });
  console.log(`\n\n=== scan_signal OpsEvents since ${fmt(since)} (${signals.length}) ===`);
  for (const ev of signals) {
    console.log(`  ${fmt(ev.createdAt)}  key=${ev.key}  ${JSON.stringify(ev.metadata)}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
