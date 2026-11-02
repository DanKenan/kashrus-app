import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// BOOTFIX (Nov 2): #187's first Cloud Run boot died with "Could not load
// durable state at boot" and an empty log line: the boot read's error was
// only in a JSON field, never in the fatal line. This test boots the server
// the way Cloud Run does (the esbuild bundle, K_SERVICE set, production,
// READ_FROM_PER_ENTITY=true) in two situations:
//   A. the boot read fails with a quota error -> the fatal line names it;
//   B. the stored document holds shifts in every shape older code wrote
//      (#186 single person, per-day people/hours, null-person days and
//      overrides, the daysOfWeek draft, short/garbled days, no overrides,
//      a one-time shift, a task left on a deleted shift, keys A-Z as
//      Firestore returns them) -> it boots and hydrates without a warning.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function buildBundle() {
  const esbuild = await import('esbuild');
  const outfile = join(REPO, 'dist', `stage2-boot-109-${process.pid}.cjs`);
  mkdirSync(dirname(outfile), { recursive: true });
  // Same flags as `npm run build` for dist/server.cjs.
  await esbuild.build({ entryPoints: [join(REPO, 'server.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile, logLevel: 'silent' });
  return outfile;
}

// Starts a server process and collects its output; resolves when it either
// answers /api/health or exits.
async function boot(args, env, port, timeoutMs = 120000) {
  const dataDir = join(tmpdir(), `stage2-boot-109-${port}`);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, args, {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), DATA_DIR_OVERRIDE: dataDir,
      JWT_SECRET: 'stage2-boot-109-jwt-secret-0123456789abcdef', RESET_CODE_PEPPER: 'stage2-boot-109-pepper-0123456789abcdef',
      STAGED_REVISION: 'true', // reads only: this extra process must not write into the suite's store
      ...env,
    },
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let exitCode = null;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exitCode = code ?? signal; resolve(); }));
  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  while (Date.now() < deadline && exitCode === null) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) { healthy = true; break; }
    } catch {}
    await Promise.race([exited, sleep(500)]);
  }
  if (exitCode === null) { child.kill('SIGKILL'); await Promise.race([exited, sleep(10000)]); }
  rmSync(dataDir, { recursive: true, force: true });
  return { healthy, exitCode, output };
}

// A gRPC endpoint that answers every call the way Firestore does when the
// free daily read quota is used up.
async function quotaEndpoint() {
  const port = await freePort();
  const server = http2.createServer();
  server.on('stream', (stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '8', 'grpc-message': encodeURIComponent('Quota exceeded. Free daily read units per project') }, { endStream: true });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { host: `127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// Firestore returns map keys sorted A-Z.
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

export default {
  name: 'Test 109: Cloud Run boot from live-shaped data; a refused boot names its cause',
  whatItProves: 'The production bundle boots in Cloud Run mode from shifts stored by older code without a hydrate warning, and when the boot read fails (quota) the fatal boot line itself carries the Firestore error.',
  async run(baseUrl, ctx) {
    const realEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
    const bundle = await buildBundle();
    try {
      // A. Boot read fails with RESOURCE_EXHAUSTED.
      const quota = await quotaEndpoint();
      let a;
      try {
        a = await boot([bundle], {
          NODE_ENV: 'production', K_SERVICE: 'stage2-boot-109', READ_FROM_PER_ENTITY: 'true',
          FIRESTORE_EMULATOR_HOST: quota.host, FIREBASE_PROJECT_ID: 'demo-boot109', FIRESTORE_DATABASE_ID: '',
        }, await freePort());
      } finally { await quota.close(); }
      assert.equal(a.healthy, false, 'boot must be refused when the state read fails');
      assert.notEqual(a.exitCode, 0, `exit code ${a.exitCode}`);
      const fatal = a.output.split('\n').find((l) => l.startsWith('Error: [Firestore] Could not load durable state at boot'));
      assert(fatal, `no fatal boot line:\n${a.output.slice(-3000)}`);
      assert.match(fatal, /Cause: 8 RESOURCE_EXHAUSTED: Quota exceeded\. Free daily read units per project/, fatal);
      const warn = a.output.split('\n').find((l) => l.includes('Could not load state'));
      assert(warn && JSON.parse(warn).message.includes('RESOURCE_EXHAUSTED'), `warning line lacks the error: ${warn}`);

      // B. Old-shape shifts in the stored document.
      const p = `boot109-${Date.now()}`;
      const agencyId = `${p}-agency`, venueId = `${p}-venue`;
      const u = (k) => `${p}-${k}`;
      const users = ['m1', 'm2', 'm3'].map((k) => ({ id: u(k), email: `${u(k)}@test.local`, name: `Boot ${k}`, role: 'mashgiach', agencyId, venueId }));
      const days7 = Array.from({ length: 7 }, (_, w) => ({ on: w < 5 }));
      const base = { agencyId, venueId, startMinutes: 480, endMinutes: 1080 };
      const shifts = [
        // #186 as stored: single person, per-day person/hours, null-person day, overrides incl. "nobody"
        { ...base, id: u('s-rec'), name: 'Deli day', area: 'Kitchen', userId: u('m1'), oneTimeDate: null,
          days: days7.map((d, w) => ({ ...d, ...(w === 1 ? { userId: u('m2') } : {}), ...(w === 2 ? { userId: null } : {}), ...(w === 3 ? { startMinutes: 600, endMinutes: 1200 } : {}) })),
          overrides: [{ date: '2026-11-03', userId: u('m3') }, { date: '2026-11-04', userId: null }], createdAt: '2026-11-01T20:00:00.000Z' },
        { ...base, id: u('s-night'), name: 'Night', area: '', startMinutes: 1320, endMinutes: 120, userId: u('m2'), days: days7.map((d, w) => ({ on: w >= 5 })), overrides: [] },
        { ...base, id: u('s-once'), name: 'One time', area: '', oneTimeDate: '2026-11-03', userId: u('m3'), days: days7, overrides: [] },
        { ...base, id: u('s-nobody'), name: 'Empty', area: 'Front', userId: null, days: days7 },
        // drafts and damage older code may have left behind
        { ...base, id: u('s-dow'), name: 'Draft', daysOfWeek: [5, 6], userId: u('m1'), userName: 'Boot m1' },
        { ...base, id: u('s-short'), name: 'Short', days: [{ on: true }, { on: true }], overrides: null },
        { ...base, id: u('s-garbled'), days: [null, { on: 'yes' }, {}, { on: true, userId: 5 }, { on: true }, { on: true }, { on: true }], overrides: [null, { date: 5 }, { date: '2026-11-05' }] },
        { ...base, id: u('s-bare') },
      ].map(sortKeys);
      const tasks = [
        { id: u('t-rec'), venueId, agencyId, title: 'Shift task', shiftId: u('s-rec'), assignedTo: [], status: 'pending', createdAt: '2026-11-01T20:00:00.000Z' },
        { id: u('t-gone'), venueId, agencyId, title: 'Deleted-shift remnant', shiftId: u('s-deleted'), assignedTo: [], status: 'pending', createdAt: '2026-11-01T20:00:00.000Z' },
      ].map(sortKeys);
      const injected = await ctx.api('POST', '/api/__test__/inject-fixture', {
        agencies: [{ id: agencyId, name: p }], venues: [{ id: venueId, agencyId, name: p, timeZone: 'America/New_York' }],
        users, shifts, tasks, venueWorkDates: { [venueId]: '2099-12-31' },
      });
      assert.equal(injected.status, 200, JSON.stringify(injected.json));

      let b;
      if (realEmulator) {
        // Exactly the production entry: the bundle, Cloud Run mode.
        let fileConfig = {};
        try { fileConfig = JSON.parse(readFileSync(join(REPO, 'firebase-applet-config.json'), 'utf8')); } catch {}
        const projectId = process.env.FIREBASE_PROJECT_ID || fileConfig.projectId || '';
        const databaseId = process.env.FIRESTORE_DATABASE_ID !== undefined ? (process.env.FIRESTORE_DATABASE_ID || '') : (fileConfig.firestoreDatabaseId || '');
        b = await boot([bundle], {
          NODE_ENV: 'production', K_SERVICE: 'stage2-boot-109', READ_FROM_PER_ENTITY: 'true',
          FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST, FIREBASE_PROJECT_ID: projectId, FIRESTORE_DATABASE_ID: databaseId,
        }, await freePort());
      } else {
        // The mock refuses Cloud Run mode; boot the same source on a copy of its store.
        const mockFile = process.env.FIRESTORE_MOCK_FILE || join(tmpdir(), 'stage2-mock-firestore.json');
        const copy = join(tmpdir(), `stage2-boot-109-mock-${process.pid}.json`);
        copyFileSync(mockFile, copy);
        try {
          b = await boot(['--import', 'tsx', 'server.ts'], {
            NODE_ENV: 'production', READ_FROM_PER_ENTITY: 'true', FIRESTORE_MOCK: 'true', FIRESTORE_MOCK_FILE: copy,
          }, await freePort());
        } finally { rmSync(copy, { force: true }); }
      }
      assert.equal(b.healthy, true, `old-shape boot failed (exit ${b.exitCode}):\n${b.output.slice(-3000)}`);
      assert(b.output.includes('[Firestore] Loaded durable state.'), b.output.slice(-3000));
      for (const bad of ['Could not hydrate state', 'Could not load state', 'refusing to start']) {
        assert(!b.output.includes(bad), `"${bad}" in boot output:\n${b.output.slice(-3000)}`);
      }
      return `quota boot refused with its cause; ${shifts.length} old-shape shifts booted (${realEmulator ? 'bundle, Cloud Run mode, real emulator' : 'tsx on the mock store'})`;
    } finally {
      rmSync(bundle, { force: true });
      rmSync(`${bundle}.map`, { force: true });
    }
  },
};
