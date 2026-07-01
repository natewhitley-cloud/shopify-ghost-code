/**
 * Piscina worker module for the scan engine.
 *
 * Thin wrapper — all detection logic lives in scan-engine.server.ts.
 * This file is compiled to build/server/scan-engine.worker.js by
 * `npm run build:worker` (esbuild) and loaded by scan-pool.server.ts
 * via Piscina worker threads.
 *
 * Contract: receives `{ files: ThemeFile[] }` via Piscina task data,
 * returns a ScanResult. Both are structured-clone serializable.
 */

import { scanThemeFiles, type ScanResult, type ThemeFile } from "./scan-engine.server";

export default function ({ files }: { files: ThemeFile[] }): ScanResult {
  return scanThemeFiles(files);
}
