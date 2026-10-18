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

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { unlinkSync, rmSync, mkdirSync } from 'node:fs';
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
    execSync(`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    // Poll until port is free (max 10s) — kill -9 is async
    for (let i = 0; i < 20; i++) {
      try {
        execSync(`lsof -ti:${SERVER_PORT}`, { stdio: 'ignore' });
        await sleep(500); // still occupied, wait
      } catch {
        break; // lsof found nothing = port free
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
  if (useRealEmulator) {
    serverEnv.FIRESTORE_ENABLED = 'true';
    // FIRESTORE_EMULATOR_HOST is inherited from process.env.
    // firebase-admin SDK connects to the emulator automatically.
    // Use a demo project ID — the emulator doesn't validate it.
    serverEnv.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-test';
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
  let serverChild = server;
  const restartServer = async () => {
    console.log('[harness] Restarting server...');
    serverChild.kill('SIGKILL');
    await sleep(2000);
    serverChild = spawnLogged('npx', ['tsx', 'server.ts'], { cwd: REPO, env: serverEnv }, 'server');
    await waitFor(`http://127.0.0.1:${SERVER_PORT}/api/venues`, { label: 'server (restarted)', timeoutMs: 120000 });
    console.log('[harness] Server restarted.');
  };

  const results = await runAll(`http://127.0.0.1:${SERVER_PORT}`, { restartServer });

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
