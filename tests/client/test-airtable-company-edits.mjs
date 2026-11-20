import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { mockAirtable } from '../stage2/test-115-sources.mjs';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
import { CompanyScreen } from '../../src/components/CompanyScreen.tsx';
import { canEdit, canEditAirtableCompany } from '../../src/lib/sourcesSetup.ts';
import { mount } from './lib/mini-render.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'company-editor-'));
process.env.FIRESTORE_MOCK_FILE = path.join(dir, 'store.json');
const db = new MockFirestore();
const { state, rows, key, mapping, patches, mock } = await mockAirtable('appTEST');
let removal, failAudit, attemptedId;
const writes = [];
const batch = db.batch.bind(db);
db.batch = () => {
  const b = batch(), set = b.set.bind(b);
  b.set = (ref, doc) => {
    if (ref.path.startsWith('sourceFeeAudit/')) {
      if (doc.outcome === failAudit) throw Error('Simulated audit outage');
      writes.push(structuredClone(doc));
    }
    return set(ref, doc);
  };
  return b;
};
state.beforePatch = () => {
  const latest = writes.at(-1);
  attemptedId = latest.operationId;
  assert.equal(db._docs['sourceFeeAudit/' + attemptedId].outcome, 'attempted');
};
const nativeFetch = globalThis.fetch;
const servers = [];
async function appInstance() {
  const app = express();
  app.use(express.json());
  const routes = registerSourceRoutes(app, { db: () => db, dataDir: dir, staged: () => false,
    secret: () => 'fixture', testMode: true, requireAdmin: () => ({ id: 'admin', agencyId: 'agency' }),
    timeZone: () => 'UTC', companyRemoval: { removal: () => removal, pendingRemovals: async () => [] } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const url = 'http://127.0.0.1:' + server.address().port;
  const api = (path, method = 'GET', body) => nativeFetch(url + path, { method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await api('/api/__test__/sources-api-base', 'POST', { url: 'http://127.0.0.1:' + mock.address().port });
  await routes.boot();
  return { url, api };
}
try {
  const first = await appInstance();
  Object.assign(mapping.companies, { brand: 'Brand', plant: 'Plant', mashgiachFee: 'Supervision' });
  const config = { sourceType: 'airtable', baseId: 'appTEST', mapping, access: 'readwrite' };
  assert.equal((await (await first.api('/api/sources/connection', 'PUT', { ...config, access: 'read', apiKey: key })).json()).access, 'read');
  state.level = 'create';
  const tested = await (await first.api('/api/sources/test', 'POST', { ...config, apiKey: '' })).json();
  assert.equal(tested.access, 'readwrite');
  assert.equal((await (await first.api('/api/sources/connection')).json()).access, 'read');
  assert.equal((await (await first.api('/api/sources/connection', 'PUT', { ...config, access: tested.access, apiKey: '' })).json()).access, 'readwrite');
  assert.equal(state.mutations, 0);
  const row = '/api/sources/rows/companies/rec0';
  await first.api(row + '/edit'); // Wait for the saved connection's background refresh.
  const { url, api } = await appInstance();
  const scopes = state.baseChecks;
  const original = rows.Companies[0].fields;
  const waitFor = async callback => {
    for (let i = 0; i < 200; i++) {
      if (await callback()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error('Timed out waiting for the editor');
  };
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  let releaseLoad;
  const initialLoad = new Promise(resolve => { releaseLoad = resolve; });
  globalThis.fetch = async (input, init) => {
    if (input === row + '/edit') await initialLoad;
    return nativeFetch(String(input).startsWith('/') ? url + input : input, init);
  };
  for (const [role, connection] of [['admin', { ...config, access: 'read' }], ['staff', config], ['admin', { ...config, sourceType: 'upload' }]])
    assert.equal(canEditAirtableCompany(role, connection), false);
  assert.equal(canEdit('admin', config), false);
  let saved = 0;
  const screen = await mount(CompanyScreen, { role: 'admin', connection: config, company: { id: 'rec0', name: 'Stale cache' },
    onClose() {}, onSourceSaved() { saved++; } }).render();
  const panel = screen.tree().props.children.props.children[1].props.children[0].props.children[1];
  const editor = await mount(panel.type, panel.props).render();
  const button = () => editor.find(node => node.props.type === 'submit')[0];
  assert.match(editor.text(), /Loading company details/);
  assert.equal(button(), undefined);
  releaseLoad();
  await waitFor(async () => { await editor.render(); return !!button(); });
  assert.equal(state.baseChecks, scopes + 1);
  assert.equal(button().props.disabled, true);
  const change = async (from, to) => {
    const input = editor.find(node => node.props.value === from && node.props.onChange)[0];
    assert.ok(input, 'Missing field ' + from);
    input.props.onChange({ target: { value: to } });
    await editor.render();
  };
  await change('Main Street', 'Draft address');
  assert.equal(button().props.disabled, false);
  for (removal of [{ archived: true }, { requested: 'delete' }, { deletedAt: 'today' }]) {
    assert.equal((await api(row + '/edit')).status, 409);
    await editor.submit();
    assert.match(editor.text(), /archived or being removed/);
    assert.equal(button().props.disabled, false);
    assert.equal(writes.at(-1).outcome, 'rejected');
  }
  removal = undefined;
  failAudit = 'attempted';
  await editor.submit();
  assert.match(editor.text(), /stopped before saving/);
  assert.equal(patches.length, 0);
  failAudit = undefined;
  state.denyConfirm = true;
  const staleSubmit = editor.find(node => node.type === 'form')[0].props.onSubmit;
  await editor.submit();
  assert.match(editor.text(), /Airtable may have saved these changes. Reload and review before retrying./);
  assert.equal(button().props.disabled, true);
  assert.equal(writes.at(-1).outcome, 'unconfirmed');
  assert.equal(writes.at(-1).operationId, attemptedId);
  await staleSubmit({ preventDefault() {} });
  await editor.submit();
  assert.equal(patches.length, 1);
  state.denyConfirm = false;
  const cachedAddress = async () => (await (await api('/api/factories')).json()).companies.find(c => c.id === 'rec0').address;
  assert.equal(await cachedAddress(), 'Main Street');
  await editor.click('Reload and review');
  assert.equal(patches.length, 1);
  assert.equal(saved, 1);
  assert.match(editor.text(), /Company details saved/);
  assert.equal(await cachedAddress(), 'Draft address');

  await change('Draft address', 'Second address');
  state.denyConfirm = true;
  await editor.submit();
  state.denyConfirm = false;
  state.failList = true;
  await editor.click('Reload and review');
  assert.equal(patches.length, 2);
  assert.match(editor.text(), /Saved in Airtable. Refresh required./);
  state.failList = false;
  assert.equal(await cachedAddress(), 'Second address');

  await change('Second address', 'Draft address');
  state.denyConfirm = true;
  await editor.submit();
  state.denyConfirm = false;
  original.Address = 'First external address';
  await editor.click('Reload and review');
  assert.match(editor.text(), /First external address/);
  assert.equal(button().props.disabled, false);
  assert.equal(patches.length, 3);

  // A second external edit now races an ordinary, deliberate save.
  original.Address = 'External address';
  await editor.submit();
  assert.match(editor.text(), /The company changed in Airtable. Reload and review./);
  assert.doesNotMatch(editor.text(), /may have saved/);
  assert.equal(button().props.disabled, true);
  assert.equal(patches.length, 3);
  await editor.click('Reload and review');
  assert.match(editor.text(), /External address/);
  assert.ok(editor.find(node => node.props.value === 'Draft address').length);
  assert.equal(patches.length, 3);
  assert.equal(button().props.disabled, false);
  await change('Company 0', 'Updated company');
  await change('Factory', 'Other');
  assert.match(editor.text(), /move out of Factories/);
  failAudit = 'confirmed';
  await editor.submit();
  assert.equal(saved, 3);
  assert.match(editor.text(), /Company details saved/);
  assert.match(editor.text(), /final edit audit could not be recorded/);
  assert.deepEqual(original, { Name: 'Updated company', Address: 'Draft address', Type: 'Other' });
  assert.equal(patches.length, 4);
  assert.equal(state.baseChecks, scopes + 4);
  failAudit = undefined;
  original.Type = 'Factory';
  // Restore eligibility via a new settings save and verify the refresh-warning path.
  await api('/api/sources/connection', 'PUT', config);
  await change('Draft address', 'Old connection draft');
  await editor.submit();
  assert.match(editor.text(), /The source connection changed. Reopen the company./);
  assert.doesNotMatch(editor.text(), /Reload and review/);
  assert.equal(patches.length, 4);
  const fresh = await (await api(row + '/edit')).json();
  state.failList = true;
  const response = await api(row, 'PATCH', { ...fresh, fields: { address: '' }, originals: { address: original.Address } });
  assert.equal((await response.json()).warning, 'Saved in Airtable. Refresh required.');
  assert.equal(writes.at(-1).outcome, 'confirmed');
  assert.equal(writes.at(-1).operationId, attemptedId);
  assert.equal(writes.at(-1).writeEvidence.verifyGet.values.address, 'Draft address');
  assert.equal(writes.at(-1).writeEvidence.confirmGet.values.address, null);
  state.failList = false;
  const factories = await (await api('/api/factories')).json();
  assert.equal(factories.companies.find(row => row.id === 'rec0').address, '');
  const patch = (fields, originals) => api(row, 'PATCH', { baseId: fresh.baseId, updatedAt: fresh.updatedAt, fields, originals });
  assert.equal((await patch({ mashgiachFee: '123' }, { mashgiachFee: null })).status, 400);
  assert.equal((await patch({ brand: 'Test Brand', plant: 'Test Plant' }, { brand: null, plant: null })).status, 200);
  assert.deepEqual(patches.at(-1), { Brand: 'Test Brand', Plant: 'Test Plant' });
  state.recordId = 'recOther';
  assert.equal((await api(row + '/edit')).status, 404);
  const patchCount = patches.length;
  assert.equal((await patch({ address: 'Changed' }, { address: null })).status, 404);
  assert.equal(patches.length, patchCount);
  delete state.recordId;
  state.denyPatch = state.baseOffline = true;
  const refused = await patch({ address: 'Changed' }, { address: null });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /Airtable 403/);
  assert.equal(writes.at(-1).outcome, 'rejected');
  assert.equal((await (await api('/api/sources/connection')).json()).access, 'readwrite');
  state.baseOffline = state.denyPatch = false;
  const checks = state.baseChecks;
  assert.equal((await patch({ address: 'Changed' }, { address: null })).status, 200);
  assert.equal(state.baseChecks, checks + 1);
  assert.equal(patches.length, patchCount + 1);
  state.level = 'read';
  // Reopen with the current binding to check that a scope downgrade disables the editor.
  const latestEditor = await mount(panel.type, panel.props).render();
  await waitFor(async () => {
    await latestEditor.render();
    return latestEditor.find(node => node.props.value === 'Changed').length > 0;
  });
  latestEditor.find(node => node.props.value === 'Changed')[0].props.onChange({ target: { value: 'Last draft' } });
  await latestEditor.render();
  state.denyPatch = true;
  await latestEditor.submit();
  assert.match(latestEditor.text(), /write access was lost/);
  assert.equal(latestEditor.find(node => node.props.type === 'submit').length, 0);
  assert.equal((await (await api('/api/sources/connection')).json()).access, 'read');
  console.log('Company editor → routes → mock Airtable verified, including cold load, review lock, source values and audit failures.');
} finally {
  globalThis.fetch = nativeFetch;
  for (const server of [...servers, mock]) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
