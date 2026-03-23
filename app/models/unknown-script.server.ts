import db from "../db.server";

export type CreateUnknownScriptInput = {
  filename: string;
  lineNumber: number;
  url: string;
  resourceType: "script" | "stylesheet";
  codeSnippet: string;
};

/**
 * Batch-insert unknown scripts for a completed scan.
 */
export async function createUnknownScripts(scanId: string, scripts: CreateUnknownScriptInput[]) {
  if (scripts.length === 0) return { count: 0 };

  return db.unknownScript.createMany({
    data: scripts.map((s) => ({ ...s, scanId })),
  });
}

/**
 * Get unknown scripts for a scan, including any merchant submissions.
 */
export async function getUnknownScriptsForScan(scanId: string) {
  return db.unknownScript.findMany({
    where: { scanId },
    include: { submissions: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Submit a merchant's identification of which app left an unknown script.
 */
export async function submitSignatureSuggestion(
  unknownScriptId: string,
  shopId: string,
  suggestedAppName: string,
) {
  return db.signatureSubmission.create({
    data: {
      unknownScriptId,
      shopId,
      suggestedAppName,
    },
  });
}
