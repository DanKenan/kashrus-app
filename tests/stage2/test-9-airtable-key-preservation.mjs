import assert from 'node:assert/strict';
import { removeLegacyKeys } from '../../src/server/sources/legacy.ts';
export default {
  name: 'Test 9: legacy Airtable key path is closed',
  whatItProves: 'Boot removes only legacy keys in one write (none when absent); live state, config and replay never expose a key.',
  async run(_baseUrl, ctx) {
    // Exercise the exact boot migration with a counted main-doc commit boundary.
    const original = { airtableConfigs: [{ id: 'legacy', apiKey: 'fake-legacy-key', baseId: 'base', tableName: 'table', viewName: 'view', fieldNameMapping: { name: 'Name' }, custom: ['preserve'] }], approvedIngredients: [{ id: 'keep', name: 'unchanged' }], other: 'untouched' };
    let doc = structuredClone(original), writes = 0, memory, logs = [];
    const deps = { blocked: () => false, configs: () => doc.airtableConfigs, install: v => { memory = v; }, log: v => logs.push(v), async commit(mutator) { const result = mutator(doc); if (result.doc !== doc) writes++; doc = result.doc; return result; } };
    await removeLegacyKeys(deps);
    const expected = structuredClone(original); delete expected.airtableConfigs[0].apiKey;
    assert.deepEqual(doc, expected); assert.deepEqual(memory, expected.airtableConfigs);
    assert.equal(writes, 1); assert.deepEqual(logs, ['[sources] removed 1 legacy keys']);
    writes = 0; await removeLegacyKeys(deps); assert.equal(writes, 0);
    const venueId = `venue-test9-${Date.now()}`;
    const before = await ctx.getDoc();
    const bad = await ctx.api('POST', '/api/airtable/config', { venueId, apiKey: 'fake-legacy-key', expectedVersion: await ctx.getVersion() });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'Keys are saved in Factories › Connect now.');
    assert.deepEqual(await ctx.getDoc(), before);
    for (const apiKey of [undefined, '']) {
      const r = await ctx.api('POST', '/api/airtable/config', { venueId, apiKey, baseId: 'appTEST9BASE1', tableName: 'Legacy table', expectedVersion: await ctx.getVersion() });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal('apiKey' in r.json.config, false);
      assert.equal(r.json.config.hasApiKey, false);
      const config = (await ctx.getDoc()).airtableConfigs.find(c => c.venueId === venueId);
      assert.equal('apiKey' in config, false);
    }
    // Inject old data after boot, proving every response projection is safe too.
    const legacyVenue = `legacy-${venueId}`, key = 'fake-private-old-key';
    await ctx.api('POST', '/api/__test__/inject-fixture', { airtableConfigs: [{ agencyId: 'agency-hkc', venueId: legacyVenue, apiKey: key, baseId: 'appOLD' }] });
    assert.equal(JSON.stringify((await ctx.api('GET', `/api/airtable/config?venueId=${legacyVenue}`)).json).includes(key), false);
    const token = ctx.authHeaders.Authorization.replace(/^Bearer /, '');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(_baseUrl.replace(/^http/, 'ws') + `/ws?token=${token}`);
      const timer = setTimeout(() => { ws.close(); reject(Error('live state timeout')); }, 10000);
      ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.type === 'INITIAL_STATE') { clearTimeout(timer); ws.close(); try { assert.equal(JSON.stringify(m).includes(key), false); resolve(); } catch (e) { reject(e); } } };
    });
    const request = { venueId: legacyVenue, baseId: 'appOLD', expectedVersion: await ctx.getVersion(), operationId: `legacy-replay-${Date.now()}` };
    for (let i = 0; i < 2; i++) {
      const r = await ctx.api('POST', '/api/airtable/config', request);
      assert.equal(r.status, 200); assert.equal(JSON.stringify(r.json).includes(key), false);
    }
    assert.equal((await ctx.getDoc()).airtableConfigs.some(c => 'apiKey' in c), false);
    const bootConfig = { id: `boot-${venueId}`, agencyId: 'agency-hkc', venueId: `boot-${venueId}`, apiKey: key, baseId: 'appBOOT', tableName: 'Legacy', viewName: 'View', fieldNameMapping: { name: 'Name' }, custom: ['unchanged'] };
    await ctx.api('POST', '/api/__test__/inject-fixture', { airtableConfigs: [bootConfig] });
    const beforeBoot = await ctx.getDoc(), version = await ctx.getVersion();
    await ctx.restartServer({});
    const afterBoot = await ctx.getDoc();
    assert.equal(await ctx.getVersion(), version + 1);
    const expectedConfigs = beforeBoot.airtableConfigs.map(({ apiKey, ...rest }) => rest);
    assert.deepEqual(afterBoot.airtableConfigs, expectedConfigs);
    assert.deepEqual(afterBoot.approvedIngredients, beforeBoot.approvedIngredients);
    await ctx.restartServer({});
    assert.equal(await ctx.getVersion(), version + 1); // no-key boot costs zero main-doc writes
    return 'legacy key-only boot migration: one write, no-key boot zero writes; config/live state/replay never leak keys';
  },
};
