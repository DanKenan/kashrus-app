/**
 * Route body for POST /api/internal/consistency-check (item 3, fix round 1).
 *
 * Extracted from server.ts so the single-writer rule is testable end to end:
 * the handler in consistency.ts is the one writer of a run's summary line,
 * but a failure BEFORE the handler takes responsibility — the dynamic import
 * of consistency.js throwing (packaging / module loading) — would otherwise
 * end with zero "[consistency] ERROR" lines for a run that could not run.
 *
 * The route therefore shares an emission marker with the handler:
 * - handler sets alert.runId as soon as it has one, and alert.emitted = true
 *   immediately after its one log call;
 * - on a throw, if nothing was emitted the route writes the run's one ERROR
 *   line itself, in the summary shape, with a locally bounded reason (this
 *   bound must NOT come from the module that may have failed to load);
 * - if the summary WAS emitted (e.g. res.json threw afterwards), the route
 *   logs a WARNING — never a second ERROR.
 */

import { log } from './log.ts';

/** Strip control chars, collapse whitespace, cap 120 — local on purpose (see header). */
function boundedRouteReason(e: unknown): string {
  const msg = (e as any)?.message ?? String(e ?? 'unknown error');
  const s = String(msg)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

interface RouteRes {
  status: (code: number) => any;
  json: (body: any) => any;
  headersSent?: boolean;
}

export async function consistencyRoute(
  firestoreDb: any,
  res: RouteRes,
  loadModule: () => Promise<any> = async () => {
    // Same .js → .ts fallback consistency.ts uses for migration: the .js
    // specifier resolves under tsx and in the bundled build; plain Node
    // type-stripping needs the literal .ts path.
    try {
      return await import('./consistency.js');
    } catch {
      return await import('./consistency.ts');
    }
  }
): Promise<void> {
  if (!firestoreDb) {
    res.status(503).json({ error: 'Firestore not available.' });
    return;
  }
  const alert: { runId?: string; emitted: boolean } = { runId: undefined, emitted: false };
  try {
    const mod = await loadModule();
    const { httpStatus, body } = await mod.handleConsistencyCheck(firestoreDb, { alert });
    res.status(httpStatus).json(body);
  } catch (e: any) {
    if (!alert.emitted) {
      const rid = alert.runId || 'pre-run';
      log.error(
        `[consistency] ERROR run=${rid} — 1 issue: 1 check-error. run: ${boundedRouteReason(e)}. Details: INFO lines run=${rid}`
      );
    } else {
      log.warn(
        `[consistency] WARNING run=${alert.runId} route error after summary: ${boundedRouteReason(e)}`
      );
    }
    if (!res.headersSent) {
      try {
        res.status(500).json({ error: 'Consistency check failed.' });
      } catch {
        /* the response write itself is broken — the log line above is the record */
      }
    }
  }
}
