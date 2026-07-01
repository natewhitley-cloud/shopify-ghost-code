-- Session: index shop for session lookups by shop domain
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- Scan: indexes serving the stale-scan query
-- predicate: (status=PENDING AND createdAt < cutoff) OR (status=IN_PROGRESS AND (startedAt < cutoff OR ...))
CREATE INDEX "Scan_status_startedAt_idx" ON "Scan"("status", "startedAt");
CREATE INDEX "Scan_status_createdAt_idx" ON "Scan"("status", "createdAt");
