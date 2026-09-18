// READ-ONLY: dump every finding for a scan, with code snippets, to eyeball
// app attribution (esp. the appName=null ones).
// Run: npx tsx --env-file=.env scripts/dump-scan-findings.ts <scanId>
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const scanId = process.argv[2] ?? "cmu48sn2600s4qg01fyhx3i87"; // d4c4c4, 26 findings

async function main() {
  const findings = await prisma.finding.findMany({
    where: { scanId },
    orderBy: [{ appName: "asc" }, { findingType: "asc" }],
  });
  console.log(`=== ${findings.length} findings for scan ${scanId} ===\n`);
  for (const f of findings) {
    console.log(
      `[${f.severity}] ${f.findingType}  app=${f.appName ?? "(NONE)"}\n` +
        `  file: ${f.filename}:${f.lineNumber}\n` +
        `  desc: ${f.description}\n` +
        `  code: ${f.codeSnippet.replace(/\s+/g, " ").slice(0, 300)}\n`,
    );
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
