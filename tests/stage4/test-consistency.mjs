/**
 * Stage 4 PR A: Consistency monitor tests.
 */
import {
  runConsistencyCheck,
  formatConsistencySummary,
  demoConsistencySummary,
  issueTypeForReason,
  boundedReason,
  sanitizeText,
} from '../../src/server/consistency.ts';
import crypto from 'crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function emailKey(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function createMockDb(monolithData, perEntityDocs = {}, versionChanges = 0) {
  const docs = new Map();
  for (const [k, v] of Object.entries(perEntityDocs)) docs.set(k, v);
  // Add a recent backup so staleness check passes (unless testing staleness)
  docs.set('backups/latest', {
    tier: 'tier1',
    createdAt: new Date().toISOString(),
    checksum: 'abc123',
  });
  let versionCalls = 0;

  const db = {
    doc(path) {
      return {
        async get() {
          if (path === 'app-state/main') {
            versionCalls++;
            // Simulate version change on first N calls if versionChanges > 0
            const v = monolithData._v + (versionCalls <= versionChanges ? 0 : versionChanges);
            // Actually: return _v that changes between before/after
            const effectiveV = versionCalls === 1 ? monolithData._v : monolithData._v + versionChanges;
            return { exists: true, data: () => ({ ...monolithData, _v: effectiveV }) };
          }
          const d = docs.get(path);
          return { exists: !!d, data: () => d };
        },
      };
    },
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          return {
            async get() {
              const d = docs.get(key);
              return { exists: !!d, data: () => d };
            },
          };
        },
        async get() {
          const result = [];
          for (const [k, v] of docs) {
            if (k.startsWith(name + '/')) result.push({ id: k.split('/')[1], data: () => v });
          }
          return { docs: result, size: result.length };
        },
      };
    },
  };
  return db;
}

export const venue = { id: 'v1', agencyId: 'agency-hkc', name: 'Crown Market', category: 'grocery', address: 'x', certification: 'HKC', createdAt: '2026-01-01' };
export const user = (id, email) => ({ id, agencyId: 'agency-hkc', email, name: 'U', role: 'mashgiach', avatarColor: '#fff', createdAt: '2026-01-01', updatedAt: '2026-01-01' });

export default {
  name: 'Stage 4 PR A: Consistency monitor',
  whatItProves: 'Version-stable retry, size warning, non-2xx on mismatch. Alert grouping: exactly one ERROR summary line per run, every finding an INFO line with the run id, retries WARNING not ERROR. Fix round 1: capped "20+" totals, best-effort INFO writes, bounded retry reasons, and the route safety net (module-load failure → one ERROR; response failure after summary → WARNING only).',

  async run() {
    // Test 1: Match + small size = ok (but backup unconfigured = stale)
    // Note: without BACKUP_BUCKET, staleness check fails closed → ok=false.
    // This is intentional: monitoring enabled but unconfigured = error.
    {
      const monolith = { _v: 5, venues: [venue], users: [user('u1', 'a@x.com')], tasks: [] };
      const perEntity = {
        'venues/v1': { ...venue, _v: 1 },
        'users/u1': { ...user('u1', 'a@x.com'), _v: 1 },
        [`usersByEmail/${emailKey('a@x.com')}`]: { userId: 'u1', email: 'a@x.com' },
      };
      const db = createMockDb(monolith, perEntity);
      const r = await runConsistencyCheck(db);
      // Backup not configured → stale → ok=false (fail closed)
      if (r.ok) throw new Error('Expected not ok when backup unconfigured (fail closed)');
      if (!r.backupStale) throw new Error('Should report backup stale when unconfigured');
      if (r.status && !r.status.match) throw new Error('Data should still match');
      console.log('  ✓ unconfigured backup = stale (fail closed), data still matches');
    }

    // Test 2: Mismatch = not ok
    {
      const monolith = { _v: 5, venues: [{ ...venue, name: 'CHANGED' }], users: [], tasks: [] };
      const perEntity = { 'venues/v1': { ...venue, _v: 1 } };
      const db = createMockDb(monolith, perEntity);
      const r = await runConsistencyCheck(db);
      if (r.ok) throw new Error('Expected not ok on mismatch');
      if (!r.status || r.status.match) throw new Error('Status should show mismatch');
      console.log('  ✓ mismatch detected, ok=false');
    }

    // Test 3: Large monolith = size warning
    {
      const bigVenue = { ...venue, description: 'x'.repeat(900 * 1024) }; // ~900 KiB
      const monolith = { _v: 5, venues: [bigVenue], users: [], tasks: [] };
      const perEntity = { 'venues/v1': { ...bigVenue, _v: 1 } };
      const db = createMockDb(monolith, perEntity);
      const r = await runConsistencyCheck(db);
      if (r.ok) throw new Error('Expected not ok on size warning');
      if (!r.monolithSizeWarn) throw new Error('Should warn on large doc');
      console.log(`  ✓ size warning at ${Math.round((r.monolithSizeBytes || 0) / 1024)} KiB`);
    }

    // Test 4: Version change mid-check triggers retry, eventually stable
    // (ok=false due to unconfigured backup, but version retry must succeed)
    {
      const monolith = { _v: 5, venues: [venue], users: [], tasks: [] };
      const perEntity = { 'venues/v1': { ...venue, _v: 1 } };
      // versionChanges=1: first attempt sees v5→v6 (retry), second sees v6→v6 (stable)
      const db = createMockDb(monolith, perEntity, 1);
      const r = await runConsistencyCheck(db);
      // Version retry must have happened and stabilized (error records it)
      if (!r.error || !r.error.includes('version changed')) {
        throw new Error(`Expected retry to be recorded in error field, got: ${r.error || 'none'}`);
      }
      // Data must match (ok=false only because backup unconfigured)
      if (!r.status || !r.status.match) throw new Error('Data should match after retry');
      if (!r.backupStale) throw new Error('Backup should be stale (unconfigured)');
      console.log(`  ✓ version-change retry happened and stabilized (ok=false only for backup)`);
    }

    // Test 5: Formatter — the pinned shapes (R4)
    {
      const runId = 'c-20261020-0905-a3f2';
      const P = '[consistency] ERROR';
      const eq = (got, want, label) => {
        if (got !== want) throw new Error(`${label}\n  got:  ${got}\n  want: ${want}`);
      };
      // 0 findings
      eq(formatConsistencySummary(P, runId, []),
        `${P} run=${runId} — 0 issues. Details: INFO lines run=${runId}`, 'formatter 0');
      // 1 finding — singular, no "and X more"
      eq(formatConsistencySummary(P, runId, [{ type: 'size-warn', item: 'monolith', detail: 'Monolith size 900 KiB (warn at 800 KiB, hard cap 900 KiB)' }]),
        `${P} run=${runId} — 1 issue: 1 size-warn. monolith: Monolith size 900 KiB (warn at 800 KiB, hard cap 900 KiB). Details: INFO lines run=${runId}`, 'formatter 1');
      // 2 findings — no "and X more"
      const two = formatConsistencySummary(P, runId, [
        { type: 'backup-stale', item: 'backup', detail: 'Last successful backup: never (threshold: 26h)' },
        { type: 'size-warn', item: 'monolith', detail: 'big' },
      ]);
      if (two.includes(' more')) throw new Error(`formatter 2 must not say "more": ${two}`);
      if (!two.includes('2 issues: 1 backup-stale, 1 size-warn.')) throw new Error(`formatter 2 counts (tie → type asc): ${two}`);
      // 3 findings — no "and X more"
      const three = formatConsistencySummary(P, runId, [
        { type: 'unreadable', item: 'run', detail: 'x' },
        { type: 'unreadable', item: 'run', detail: 'x' },
        { type: 'check-error', item: 'run', detail: 'x' },
      ]);
      if (three.includes('and 0 more') || three.includes(' more.')) throw new Error(`formatter 3 must not say "more": ${three}`);
      // The pinned 12-of-3-types line
      const issues12 = [
        ...Array.from({ length: 7 }, (_, i) => ({ type: 'mismatch-missing', item: `venues/v${i + 1}`, detail: 'Missing in per-entity collection' })),
        ...Array.from({ length: 3 }, (_, i) => ({ type: 'mismatch-field', item: `users/u${i + 1}`, detail: 'Field mismatch: name' })),
        ...Array.from({ length: 2 }, (_, i) => ({ type: 'mismatch-orphan', item: `tasks/t${i + 1}`, detail: 'In per-entity but not in monolith (orphan)' })),
      ];
      eq(formatConsistencySummary(P, runId, issues12),
        `${P} run=${runId} — 12 issues: 7 mismatch-missing, 3 mismatch-field, 2 mismatch-orphan. ` +
        `venues/v1: Missing in per-entity collection; venues/v2: Missing in per-entity collection; venues/v3: Missing in per-entity collection and 9 more. ` +
        `Details: INFO lines run=${runId}`, 'formatter 12');
      // >3 types — the folded types are named as a count, never silently dropped
      const fiveTypes = formatConsistencySummary(P, runId, [
        { type: 'size-warn', item: 'monolith', detail: 'x' },
        { type: 'backup-stale', item: 'backup', detail: 'x' },
        { type: 'check-error', item: 'run', detail: 'x' },
        { type: 'unreadable', item: 'run', detail: 'x' },
        { type: 'mismatch-field', item: 'users/u1', detail: 'x' },
      ]);
      if (!fiveTypes.includes('(+2 more types)')) throw new Error(`formatter >3 types must fold openly: ${fiveTypes}`);
      if (!fiveTypes.includes(' and 2 more.')) throw new Error(`formatter 5 items must say "and 2 more": ${fiveTypes}`);
      // Unknown type → mismatch-other; long item/detail capped; newlines collapsed
      const messy = formatConsistencySummary(P, runId, [
        { type: 'brand-new-type', item: 'x'.repeat(60), detail: 'line one\nline two\t' + 'y'.repeat(100) },
      ]);
      if (!messy.includes('1 mismatch-other')) throw new Error(`unknown type must become mismatch-other: ${messy}`);
      if (messy.includes('\n')) throw new Error('summary must be a single line');
      if (!messy.includes('x'.repeat(47) + '…')) throw new Error(`item must cap at 48 chars with …: ${messy}`);
      if (!messy.includes('line one line two')) throw new Error(`detail whitespace must collapse: ${messy}`);
      // Reason → type mapping, incl. malformed reasons
      const map = [
        ['Missing in per-entity collection', 'mismatch-missing'],
        ['Field mismatch: name, role', 'mismatch-field'],
        ['In per-entity but not in monolith (orphan)', 'mismatch-orphan'],
        ['Duplicate normalized email in monolith', 'mismatch-duplicate-email'],
        ['Missing email lookup', 'mismatch-email-lookup'],
        ['Email lookup points to wrong user', 'mismatch-email-lookup'],
        ['Extra lookup not in monolith', 'mismatch-email-lookup'],
        ['Some future reason nobody has seen', 'mismatch-other'],
        [undefined, 'mismatch-other'],
        [null, 'mismatch-other'],
        [42, 'mismatch-other'],
      ];
      for (const [reason, want] of map) {
        const got = issueTypeForReason(reason);
        if (got !== want) throw new Error(`issueTypeForReason(${JSON.stringify(reason)}) = ${got}, want ${want}`);
      }
      // boundedReason / sanitizeText: multi-line exception → one bounded line
      const br = boundedReason(new Error('boom\nsecond line '.repeat(20)));
      if (br.includes('\n') || br.length > 120) throw new Error(`boundedReason must be one line ≤120 chars, got ${br.length}`);
      if (sanitizeText('a\x00b\x7fc', 80) !== 'a b c') throw new Error('sanitizeText must strip control chars');
      console.log('  ✓ formatter: 0/1/2/3/12 findings, >3 types folded openly, caps + sanitize, reason map');
    }

    // Test 6: Demo summary (R6) — grouped shape, marked not-real, never the real prefix
    {
      const { runId, summary } = demoConsistencySummary('2026-10-20T09:05:00.000Z');
      if (runId !== 'test-2026-10-20T09:05:00.000Z-demo') throw new Error(`demo runId: ${runId}`);
      if (!summary.startsWith('[alert-test] TEST ALERT (demo')) throw new Error(`demo prefix: ${summary}`);
      if (!summary.includes('not real data')) throw new Error('demo must say "not real data"');
      if (summary.includes('[consistency] ERROR')) throw new Error('demo must NEVER contain the real consistency prefix');
      if (!summary.includes('12 issues: 7 mismatch-missing, 3 mismatch-field, 2 mismatch-orphan')) {
        throw new Error(`demo counts: ${summary}`);
      }
      if (!summary.endsWith(`Details: INFO lines run=${runId}`)) throw new Error(`demo suffix: ${summary}`);
      console.log('  ✓ demo summary: grouped shape, not-real-data, no real prefix');
    }

    // Tests 7–8: Run-level, through the REAL structured logger in a child
    // process spawned with K_SERVICE set (as test-logging.mjs does in-process
    // with a query import — a child is the only way to give consistency.ts a
    // from-birth structured log, since it imports log.ts itself).
    {
      const here = dirname(fileURLToPath(import.meta.url));
      const fixture = join(here, 'fixtures', 'consistency-grouped-run.mjs');
      const runFixture = (scenario) => {
        const resultFile = join(mkdtempSync(join(tmpdir(), 'cons-')), 'result.json');
        const child = spawnSync(process.execPath, [fixture, scenario, resultFile], {
          env: { ...process.env, K_SERVICE: 'test-service' },
          encoding: 'utf8',
        });
        if (child.status !== 0) {
          throw new Error(`fixture ${scenario} exited ${child.status}: ${(child.stderr || '').slice(-600)}`);
        }
        const lines = (s) => (s || '').split('\n').filter(Boolean);
        const structured = (arr) => arr.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.component === 'shutfey-server');
        return {
          errors: structured(lines(child.stderr)).filter((e) => e.severity === 'ERROR'),
          stderrRaw: lines(child.stderr),
          infos: structured(lines(child.stdout)).filter((e) => e.severity === 'INFO'),
          warns: structured(lines(child.stdout)).filter((e) => e.severity === 'WARNING'),
          result: JSON.parse(readFileSync(resultFile, 'utf8')),
        };
      };

      // Test 7: 12 findings + fresh backup → exactly ONE ERROR, 12 INFO, no other ERROR
      {
        const { errors, infos, result } = runFixture('grouped');
        const body = result.body;
        if (result.httpStatus !== 500) throw new Error(`grouped httpStatus ${result.httpStatus}`);
        if (!Array.isArray(body.issues) || body.issues.length !== 12) {
          throw new Error(`grouped issues ${body.issues?.length}`);
        }
        if (errors.length !== 1) throw new Error(`expected exactly 1 ERROR line, got ${errors.length}`);
        if (errors[0].message !== body.summary) throw new Error('the one ERROR line must be the summary');
        if (errors[0].message !== formatConsistencySummary('[consistency] ERROR', body.runId, body.issues)) {
          throw new Error(`summary must be the pinned format:\n${errors[0].message}`);
        }
        if (!errors[0].message.includes('12 issues: 7 mismatch-missing, 3 mismatch-field, 2 mismatch-orphan')) {
          throw new Error(`grouped counts: ${errors[0].message}`);
        }
        if (!errors[0].message.endsWith(`Details: INFO lines run=${body.runId}`)) {
          throw new Error(`grouped suffix: ${errors[0].message}`);
        }
        if (infos.length !== 12) throw new Error(`expected 12 INFO lines, got ${infos.length}`);
        for (const [i, info] of infos.entries()) {
          const issue = body.issues[i];
          const want = `[consistency] INFO run=${body.runId} ${issue.type} ${issue.item}: ${issue.detail}`;
          if (info.message !== want) throw new Error(`INFO line ${i}:\n  got:  ${info.message}\n  want: ${want}`);
        }
        console.log('  ✓ run-level: 12 findings → exactly one ERROR summary + 12 INFO lines (real logger)');
      }

      // Test 8: a throw after ≥1 finding → still exactly one ERROR (check-error), 500
      {
        const { errors, infos, result } = runFixture('throw');
        const body = result.body;
        if (result.httpStatus !== 500) throw new Error(`throw httpStatus ${result.httpStatus}`);
        if (errors.length !== 1) throw new Error(`throw: expected exactly 1 ERROR line, got ${errors.length}`);
        const types = (body.issues || []).map((i) => i.type);
        if (!types.includes('check-error')) throw new Error(`throw: issues must include check-error: ${types}`);
        if (types.filter((t) => t === 'mismatch-missing').length !== 7) {
          throw new Error(`throw: findings collected before the throw must survive: ${types}`);
        }
        if (body.error !== 'gcs exploded second line') {
          throw new Error(`throw: body.error must be the bounded single-line reason, got: ${body.error}`);
        }
        if (errors[0].message !== body.summary) throw new Error('throw: the one ERROR line must be the summary');
        if (infos.length !== body.issues.length) {
          throw new Error(`throw: every issue incl. check-error gets an INFO line (${infos.length} vs ${body.issues.length})`);
        }
        console.log('  ✓ run-level: throw after findings → one ERROR with check-error, findings kept');
      }

      // Test 9 (fix round 1): capped total — migration lists at most 20
      // mismatches, so at the cap the summary must read "20+ issues".
      {
        const twenty = Array.from({ length: 20 }, (_, i) => ({
          type: 'mismatch-missing', item: `venues/m${i + 1}`, detail: 'Missing in per-entity collection',
        }));
        const cappedLine = formatConsistencySummary('[consistency] ERROR', 'c-cap', twenty, { capped: true });
        if (!cappedLine.includes('— 20+ issues: 20 mismatch-missing.')) {
          throw new Error(`capped line must read "20+ issues": ${cappedLine}`);
        }
        if (!cappedLine.endsWith('Details: INFO lines run=c-cap')) throw new Error(`capped suffix: ${cappedLine}`);
        const plainLine = formatConsistencySummary('[consistency] ERROR', 'c-cap', twenty);
        if (!plainLine.includes('— 20 issues: 20 mismatch-missing.')) {
          throw new Error(`uncapped line must read "20 issues": ${plainLine}`);
        }
        console.log('  ✓ formatter: capped list reads "20+ issues", uncapped reads "20 issues"');
      }

      // Test 10 (fix round 1): an INFO write that throws must not suppress
      // the ERROR summary. The check itself did not fail → no check-error.
      {
        const { errors, infos, result } = runFixture('info-throws');
        const body = result.body;
        if (result.httpStatus !== 500) throw new Error(`info-throws httpStatus ${result.httpStatus}`);
        if (!Array.isArray(body.issues) || body.issues.length !== 12) {
          throw new Error(`info-throws issues ${body.issues?.length}`);
        }
        if (body.issues.some((i) => i.type === 'check-error')) {
          throw new Error('info-throws: INFO failure is swallowed by design — no check-error expected');
        }
        if (errors.length !== 1) throw new Error(`info-throws: expected exactly 1 ERROR line, got ${errors.length}`);
        if (errors[0].message !== body.summary) throw new Error('info-throws: the one ERROR line must be the summary');
        if (infos.length !== 1) throw new Error(`info-throws: only the first INFO line survives, got ${infos.length}`);
        console.log('  ✓ run-level: INFO write throws after first finding → summary still emitted, no check-error');
      }

      // Test 11 (fix round 1): a multi-line perEntityStatus error → the
      // retry WARNING lines are bounded and single-line. Max derived length:
      // 26-char prefix + 20-char run id + 37-char label + 120-char cap = 203.
      {
        const { errors, warns, result } = runFixture('status-throws');
        const body = result.body;
        if (result.httpStatus !== 500) throw new Error(`status-throws httpStatus ${result.httpStatus}`);
        if (errors.length !== 1) throw new Error(`status-throws: expected exactly 1 ERROR line, got ${errors.length}`);
        if (!(body.issues || []).some((i) => i.type === 'unreadable')) {
          throw new Error(`status-throws: issues must include unreadable: ${(body.issues || []).map((i) => i.type)}`);
        }
        if (warns.length !== 3) throw new Error(`status-throws: expected 3 WARNING lines, got ${warns.length}`);
        for (const w of warns) {
          if (!w.message.includes('perEntityStatus failed (attempt')) {
            throw new Error(`status-throws: WARNING text: ${w.message}`);
          }
          if (w.message.includes('\n')) throw new Error(`status-throws: WARNING must be single-line: ${w.message}`);
          if (w.message.length > 203) throw new Error(`status-throws: WARNING too long (${w.message.length}): ${w.message}`);
        }
        console.log('  ✓ run-level: multi-line perEntityStatus error → 3 bounded single-line WARNINGs, one ERROR');
      }

      // Test 12 (fix round 1, ChatGPT LOW 4): the route body.
      // (a) the handler module fails to load → exactly one ERROR in the
      //     summary shape with run=pre-run, 500, no WARNING.
      {
        const { errors, warns, result } = runFixture('route-import-fails');
        if (result.httpStatus !== 500) throw new Error(`route-import-fails status ${result.httpStatus}`);
        if (errors.length !== 1) throw new Error(`route-import-fails: expected exactly 1 ERROR, got ${errors.length}`);
        const m = errors[0].message;
        if (!m.startsWith('[consistency] ERROR run=pre-run — 1 issue: 1 check-error. run: ')) {
          throw new Error(`route-import-fails line shape: ${m}`);
        }
        if (!m.endsWith('Details: INFO lines run=pre-run')) throw new Error(`route-import-fails suffix: ${m}`);
        if (m.includes('\n')) throw new Error('route-import-fails: reason must be collapsed to one line');
        if (warns.length !== 0) throw new Error(`route-import-fails: no WARNING expected, got ${warns.length}`);
        console.log('  ✓ route: module load failure → exactly one ERROR (run=pre-run), 500');
      }
      // (b) the response write throws after a normal summary → no second
      //     ERROR; one WARNING "route error after summary" with the run id.
      {
        const { errors, infos, warns, result } = runFixture('route-json-throws');
        if (result.httpStatus !== 500) throw new Error(`route-json-throws status ${result.httpStatus}`);
        if (errors.length !== 1) throw new Error(`route-json-throws: expected exactly 1 ERROR, got ${errors.length}`);
        const m = errors[0].message;
        if (!m.startsWith('[consistency] ERROR run=c-')) throw new Error(`route-json-throws summary: ${m}`);
        if (!infos.some((i) => i.message.includes('backup-unconfigured backup:'))) {
          throw new Error('route-json-throws: the real run must carry a backup-unconfigured finding (BACKUP_BUCKET unset in the child)');
        }
        const runId = m.match(/run=(c-[\d-]+[0-9a-f]+)/)?.[1];
        const after = warns.filter((w) => w.message.includes('route error after summary'));
        if (after.length !== 1) throw new Error(`route-json-throws: expected 1 after-summary WARNING, got ${after.length}`);
        if (runId && !after[0].message.includes(`run=${runId}`)) {
          throw new Error(`route-json-throws: WARNING must carry the run id: ${after[0].message}`);
        }
        console.log('  ✓ route: response write fails after summary → no second ERROR, one WARNING');
      }
    }

    console.log('  ✓ All consistency tests passed');
  },
};
