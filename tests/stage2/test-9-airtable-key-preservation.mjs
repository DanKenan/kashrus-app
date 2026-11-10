import assert from 'node:assert/strict';
export default {
  name: 'Test 9: legacy Airtable key path is closed',
  whatItProves: 'Non-empty keys are rejected without a write; ordinary settings still save without adding a key.',
  async run(_baseUrl, ctx) {
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
    return '400 saves nothing; missing and empty keys save settings without a plaintext key';
  },
};
