/**
 * Test 9: Airtable API key preservation — updating the config without
 * re-sending the API key (or base ID) must NOT wipe the stored secret.
 * Only an explicitly provided non-empty key replaces it.
 */
export default {
  name: 'Test 9: Airtable API key preservation',
  whatItProves:
    'A config update that omits apiKey/baseId preserves the stored secrets; an explicit non-empty key replaces them; an empty string does not wipe.',

  async run(baseUrl, ctx) {
    const venueId = `venue-test9-${Date.now()}`;
    const key1 = `pat-test9-key1-${Date.now()}`;
    const key2 = `pat-test9-key2-${Date.now()}`;
    const base1 = `appTEST9BASE1`;
    const base2 = `appTEST9BASE2`;

    const findConfig = async () => {
      const doc = await ctx.getDoc();
      const arr = Array.isArray(doc.airtableConfigs) ? doc.airtableConfigs : [];
      return arr.find((c) => c && c.venueId === venueId);
    };
    const api = async (body) => {
      // save-airtable-config is an update endpoint: the version contract
      // requires the version the client saw. Fetch it fresh per call since
      // each call bumps the version.
      const v = await ctx.getVersion();
      return ctx.api('POST', '/api/airtable/config', { venueId, expectedVersion: v, ...body });
    };

    // 1. Create the config with a key + base ID.
    const r1 = await api({ apiKey: key1, baseId: base1, tableName: 'T9-Table' });
    if (r1.status !== 200) {
      throw new Error(`create failed: ${r1.status} ${JSON.stringify(r1.json)}`);
    }
    if (!r1.json.config?.hasApiKey) throw new Error('create: hasApiKey should be true');
    let cfg = await findConfig();
    if (!cfg) throw new Error('create: config not found in Firestore doc');
    if (cfg.apiKey !== key1) throw new Error('create: stored apiKey mismatch');
    if (cfg.baseId !== base1) throw new Error('create: stored baseId mismatch');

    // 2. Update WITHOUT apiKey/baseId (e.g. the form saved other fields).
    const r2 = await api({ tableName: 'T9-Table-Renamed' });
    if (r2.status !== 200) {
      throw new Error(`update-without-key failed: ${r2.status} ${JSON.stringify(r2.json)}`);
    }
    if (!r2.json.config?.hasApiKey) {
      throw new Error('update-without-key: hasApiKey false — the stored key was wiped!');
    }
    cfg = await findConfig();
    if (cfg.apiKey !== key1) throw new Error('update-without-key: stored apiKey was wiped/changed');
    if (cfg.baseId !== base1) throw new Error('update-without-key: stored baseId was wiped/changed');
    if (cfg.tableName !== 'T9-Table-Renamed') throw new Error('update-without-key: tableName was not updated');

    // 3. Update WITH an explicit new key + base ID → both change.
    const r3 = await api({ apiKey: key2, baseId: base2 });
    if (r3.status !== 200) {
      throw new Error(`update-with-key failed: ${r3.status} ${JSON.stringify(r3.json)}`);
    }
    cfg = await findConfig();
    if (cfg.apiKey !== key2) throw new Error('update-with-key: stored apiKey did not change to the new key');
    if (cfg.baseId !== base2) throw new Error('update-with-key: stored baseId did not change to the new base');

    // 4. Update with EMPTY strings → preserved, not wiped.
    const r4 = await api({ apiKey: '', baseId: '' });
    if (r4.status !== 200) {
      throw new Error(`update-empty-key failed: ${r4.status} ${JSON.stringify(r4.json)}`);
    }
    cfg = await findConfig();
    if (cfg.apiKey !== key2) throw new Error('update-empty-key: stored apiKey was wiped by empty string');
    if (cfg.baseId !== base2) throw new Error('update-empty-key: stored baseId was wiped by empty string');

    return 'key/baseId preserved across key-less updates, replaced on explicit update, empty string does not wipe';
  },
};
