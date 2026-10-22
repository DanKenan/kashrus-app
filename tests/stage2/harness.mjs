/**
 * Stage 2 test harness.
 *
 * Spawns the Shutfey server (server.ts via tsx) with FIRESTORE_MOCK=true
 * (in-memory Firestore mock with faithful transaction semantics), then runs
 * the 8 Stage 2 tests via HTTP against the server's API.
 *
 * Why a mock instead of the emulator: the Firestore emulator's backend does
 * not function in this sandbox (503 "Network closed for unknown reason" on
 * every request, even via REST). The mock in tests/stage2/firestore-mock.mjs
 * implements the exact transaction semantics Stage 2 depends on (optimistic
 * concurrency, atomic commits, contention retries). See its header for the
 * documented limitations.
 *
 * Usage:
 *   node tests/stage2/harness.mjs            # runs all tests
 *   node tests/stage2/harness.mjs --keep     # leaves server running for debugging
 *
 * Env overrides:
 *   SERVER_PORT=3100
 */

import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { unlinkSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_PORT = Number(process.env.SERVER_PORT || 3100);
const REPO = new URL('../..', import.meta.url).pathname;
const KEEP = process.argv.includes('--keep');

const children = [];

function spawnLogged(cmd, args, opts, label) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  children.push(child);
  return child;
}

async function waitFor(url, { timeoutMs = 60000, label = 'service' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      // 401 = server is up but the endpoint needs auth — that counts as ready.
      if (res.ok || res.status === 404 || res.status === 401) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
}

async function main() {
  // Mode selection: real emulator if FIRESTORE_EMULATOR_HOST is set and
  // FIRESTORE_MOCK is not explicitly 'true'. Otherwise use the in-memory mock.
  // CI sets FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 + FIRESTORE_ENABLED=true.
  const useRealEmulator =
    process.env.FIRESTORE_EMULATOR_HOST &&
    process.env.FIRESTORE_MOCK !== 'true';
  const modeLabel = useRealEmulator
    ? `REAL Firestore emulator (${process.env.FIRESTORE_EMULATOR_HOST})`
    : 'in-memory mock (FIRESTORE_MOCK=true)';
  console.log(`=== Stage 2 test harness (${modeLabel}) ===`);
  console.log(`Repo: ${REPO}`);

  // Fresh mock state and isolated data dir for each run.
  const mockFile = process.env.FIRESTORE_MOCK_FILE || join(tmpdir(), 'stage2-mock-firestore.json');
  try { unlinkSync(mockFile); } catch {}
  const dataDir = join(tmpdir(), 'stage2-server-data');
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  mkdirSync(dataDir, { recursive: true });
  if (!useRealEmulator) console.log(`Mock persistence file: ${mockFile} (cleared)`);
  console.log(`Server data dir: ${dataDir} (fresh)`);

  // Pre-flight: kill anything already on the test port (stale servers from
  // previous runs cause EADDRINUSE / WebSocket port-conflict errors).
  // Wait until the port is actually free before proceeding.
  try {
    const { execSync } = await import('node:child_process');
    execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    // Poll until port is free (max 10s) — kill -9 is async
    for (let i = 0; i < 20; i++) {
      try {
        execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN`, { stdio: 'ignore' });
        await sleep(500); // still occupied, wait
      } catch {
        break; // nothing listening = port free
      }
    }
  } catch {
    // lsof not available or nothing to kill — continue
  }

  // Server with Firestore → mock or real emulator.
  console.log(`\n[1/2] Starting server on :${SERVER_PORT} (Firestore → ${useRealEmulator ? 'real emulator' : 'in-memory mock'})...`);
  const serverEnv = {
    ...process.env,
    PORT: String(SERVER_PORT),
    DATA_DIR_OVERRIDE: dataDir,
    NODE_ENV: 'test',
    // Enables test-only endpoints (/api/__test__/last-reset-code, etc.).
    // Never set in production.
    STAGE2_TEST_MODE: 'true',
  };
  // Fresh-state target (S2F-RV1 B1): resolved ONCE with server.ts
  // getFirestoreConfig()'s precedence (env FIREBASE_PROJECT_ID, else the
  // config file's projectId; an explicitly set FIRESTORE_DATABASE_ID, even
  // empty, else the file's firestoreDatabaseId), then PINNED in the server env,
  // so the server and the emulator wipe always use the same project and db.
  let emuTarget = null;
  if (useRealEmulator) {
    serverEnv.FIRESTORE_ENABLED = 'true';
    // FIRESTORE_EMULATOR_HOST is inherited from process.env.
    // firebase-admin SDK connects to the emulator automatically.
    // Use a demo project ID — the emulator doesn't validate it.
    serverEnv.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-test';
    let fileConfig = {};
    try { fileConfig = JSON.parse(readFileSync(join(REPO, 'firebase-applet-config.json'), 'utf8')); } catch {}
    const projectId = process.env.FIREBASE_PROJECT_ID || fileConfig.projectId || '';
    const databaseId = process.env.FIRESTORE_DATABASE_ID !== undefined
      ? (process.env.FIRESTORE_DATABASE_ID || '')
      : (fileConfig.firestoreDatabaseId || '');
    emuTarget = { host: process.env.FIRESTORE_EMULATOR_HOST, projectId, databaseId };
    serverEnv.FIREBASE_PROJECT_ID = projectId;
    serverEnv.FIRESTORE_DATABASE_ID = databaseId;
    console.log(`Emulator target (server + fresh-state wipe): project ${projectId || '(none)'}, db ${databaseId || '(default)'}`);
  } else {
    serverEnv.FIRESTORE_MOCK = 'true';
    serverEnv.FIRESTORE_MOCK_FILE = mockFile;
  }
  const server = spawnLogged('npx', ['tsx', 'server.ts'], { cwd: REPO, env: serverEnv }, 'server');
  await waitFor(`http://127.0.0.1:${SERVER_PORT}/api/venues`, { label: 'server', timeoutMs: 120000 });
  console.log('Server is up.');

  // Run the tests
  console.log('\n[2/2] Running tests...\n');
  const { runAll } = await import('./run-all.mjs');

  // Test 5 needs to kill and restart the server. Provide a restart hook.
  // Accepts optional env overrides (e.g., { FORCE_LOCAL_MODE: 'true' } for
  // test 11's maintenance-mode verification).
  let serverChild = server;
  const restartServer = async (envOverrides = {}) => {
    console.log('[harness] Restarting server...');
    serverChild.kill('SIGKILL');
    // npx spawns a child node process; SIGKILL to the parent can orphan it.
    // Kill by port to catch orphans (CI failure 2026-10-18: orphaned node
    // kept :3100, "port did not release within 15s").
    // CRITICAL: -sTCP:LISTEN only — a bare -ti:3100 also matches the
    // harness's own keep-alive client connections, and xargs kill -9 would
    // kill the test runner itself (silent CI death, 2026-10-18).
    try {
      execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
    } catch { /* nothing listening — fine */ }
    // Wait for the port to actually release before rebinding — kill is async
    // and rebinding too early causes EADDRINUSE.
    const portFreeDeadline = Date.now() + 15000;
    for (;;) {
      try {
        execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN`, { stdio: 'ignore' });
      } catch {
        break; // nothing listening — port is free
      }
      if (Date.now() > portFreeDeadline) {
        throw new Error(`port ${SERVER_PORT} did not release within 15s after SIGKILL`);
      }
      await sleep(250);
    }
    const restartEnv = { ...serverEnv, ...envOverrides };
    serverChild = spawnLogged('npx', ['tsx', 'server.ts'], { cwd: REPO, env: restartEnv }, 'server');
    await waitFor(`http://127.0.0.1:${SERVER_PORT}/api/venues`, { label: 'server (restarted)', timeoutMs: 120000 });
    console.log('[harness] Server restarted.');
  };

  // Fresh state (stage2 doc-size fix): every test shares ONE app-state doc,
  // and the whole suite's fixtures together outgrew the server's 900 KiB
  // guard (CI, Oct 22 2026: Test 68 got 503 "Document too large"). run-all
  // calls this at its FRESH_STATE markers: stop the server, wipe ALL stored
  // state (emulator: every document of the project; mock: its persistence
  // file; plus the server data dir), and boot a fresh server, exactly like the
  // suite's own start. The server's 900 KiB guard itself is untouched.
  const freshState = async () => {
    console.log('[harness] Fresh state: wiping stored state and restarting the server...');
    // Stop the old server for good BEFORE the wipe (npx can orphan the real
    // node process, so kill whatever listens on the port and wait for it).
    serverChild.kill('SIGKILL');
    try { execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    const stopDeadline = Date.now() + 15000;
    for (;;) {
      try { execSync(`lsof -ti:${SERVER_PORT} -sTCP:LISTEN`, { stdio: 'ignore' }); } catch { break; }
      if (Date.now() > stopDeadline) throw new Error(`port ${SERVER_PORT} did not release within 15s (fresh state)`);
      await sleep(250);
    }
    if (useRealEmulator) {
      // Fail closed (S2F-RV1 N1): only a loopback emulator and a Firebase
      // demo-* project (emulator-only by definition) may be wiped.
      const { host, projectId, databaseId } = emuTarget;
      if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(String(host || ''))) throw new Error(`fresh state refused: emulator host ${host} is not loopback`);
      if (!/^demo-[a-z0-9-]+$/.test(projectId)) throw new Error(`fresh state refused: project ${projectId || '(none)'} is not a demo-* emulator project`);
      const db = databaseId || '(default)';
      // Preflight: the server's state doc must exist in this exact target.
      const probe = await fetch(`http://${host}/v1/projects/${projectId}/databases/${db}/documents/app-state/main`, { headers: { Authorization: 'Bearer owner' } }); // emulator admin read
      if (probe.status !== 200) throw new Error(`fresh state refused: app-state/main not found in ${projectId}/${db} (${probe.status}), so the wipe target is not the server's db`);
      const r = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/${db}/documents`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`emulator wipe failed: ${r.status} ${await r.text()}`);
    } else {
      try { unlinkSync(mockFile); } catch {}
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    mkdirSync(dataDir, { recursive: true });
    await restartServer({});
    console.log('[harness] Fresh state ready.');
  };

  const results = await runAll(`http://127.0.0.1:${SERVER_PORT}`, { restartServer, freshState });

  const failed = results.filter((r) => !r.pass);
  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.pass) console.log(`      ${r.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);

  if (KEEP) {
    console.log('\n--keep: leaving emulator + server running. Ctrl+C to stop.');
    await new Promise(() => {});
  }

  for (const c of children) c.kill();
  process.exit(failed.length ? 1 : 0);
}

process.on('SIGINT', () => {
  for (const c of children) c.kill();
  process.exit(130);
});

main().catch((err) => {
  console.error('Harness failed:', err);
  for (const c of children) c.kill();
  process.exit(2);
});
