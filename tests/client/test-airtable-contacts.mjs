import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';

const table = (name, id, fields) => ({ name, id, fields });
const field = (name, type, options) => ({ name, type, options });
const link = field('Establishments', 'multipleRecordLinks', { linkedTableId: 'tblEstablishments' });
const contactFields = [
  field('Name', 'formula', { result: { type: 'singleLineText' } }), link, field('Phone Number', 'phoneNumber'),
  field('Email', 'email'), field('Role', 'multipleSelects'), field('First name', 'singleLineText'),
  field('Private notes', 'multilineText'),
];
const core = [
  table('Establishments', 'tblEstablishments', [field('Name', 'singleLineText'), field('Annual Fee', 'currency')]),
  table('Ingredients', 'tblIngredients', [field('Name', 'singleLineText'), link]),
  table('Products', 'tblProducts', [field('Name', 'singleLineText'), link]),
];
const contactTable = table('Contacts', 'tblContacts', contactFields);
let schema = [...core, contactTable];
const mapping = {
  companies: { table: 'Establishments', name: 'Name', companyFee: 'Annual Fee' },
  ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Establishments' },
  products: { table: 'Products', name: 'Name', companyLink: 'Establishments' },
  group1Values: [],
};
const contactsMapping = {
  table: 'Contacts', companyLink: 'Establishments', name: 'Name', phone: 'Phone Number',
  email: 'Email', roles: 'Role', firstName: 'First name',
};
const ids = ['recCompanyA', 'recCompanyB', 'recCompanyC'];
const rows = {
  Establishments: ids.map((id, i) => ({ id, fields: { Name: 'Test factory ' + i, 'Annual Fee': 250 } })),
  Ingredients: [{ id: 'recIngredient', fields: { Name: 'Salt', Establishments: [ids[0]] } }],
  Products: [{ id: 'recProduct', fields: { Name: 'Crackers', Establishments: [ids[0]] } }],
  Contacts: Array.from({ length: 31 }, (_, i) => ({
    id: 'recContact' + i,
    fields: {
      Name: i ? 'Airtable contact ' + i : '', 'First name': 'Airtable fallback', 'Phone Number': ' 555-0199 ',
      Email: 'airtable' + i + '@example.test', Role: ['Owner', 'Secondary Contact'],
      Establishments: i === 0 ? [ids[0], ids[1], ids[0]] : [ids[i % 3]],
      'Private notes': 'raw-contact-row-sentinel',
    },
  })),
};

const originalFetch = globalThis.fetch, clock = Date.now;
let clockOffset = 0, outage = false, failContactAt = 0;
const requests = [];
Date.now = () => clock() + clockOffset;
globalThis.fetch = async (url, init) => {
  const path = new URL(url);
  assert.equal(path.host, 'api.airtable.com');
  assert.equal(init.method, 'GET');
  requests.push(path);
  if (outage) return Response.json({}, { status: 503 });
  if (path.pathname === '/v0/meta/bases') return Response.json({ bases: [{ id: 'appMockContacts', permissionLevel: 'read' }] });
  if (path.pathname.endsWith('/tables')) return Response.json({ tables: schema });
  const name = decodeURIComponent(path.pathname.split('/').at(-1));
  assert.ok(Object.hasOwn(rows, name), path.href);
  const offset = Number(path.searchParams.get('offset') ?? 0);
  if (name === 'Contacts') {
    assert.deepEqual(new Set(path.searchParams.getAll('fields[]')), new Set(Object.values(contactsMapping).slice(1)));
    if (failContactAt === offset) return Response.json({}, { status: 503 });
    return Response.json({
      records: rows.Contacts.slice(offset, offset + 11),
      ...(offset + 11 < rows.Contacts.length && { offset: String(offset + 11) }),
    });
  }
  return Response.json({ records: rows[name] });
};

const dir = await mkdtemp(join(tmpdir(), 'shutfey-airtable-contacts-'));
const person = (role, agencyId = 'testAgency') => ({ role, id: role, name: 'Test ' + role, agencyId });
const admin = person('admin'), coordinator = person('coordinator'), mashgiach = person('mashgiach');
const infoPath = '/api/inspections/company-info/:placeId', airtablePath = infoPath + '/airtable-contacts';
const connectionPath = '/api/sources/connection';
const config = { sourceType: 'airtable', baseId: 'appMockContacts', apiKey: 'fake-test-key', access: 'read', mapping };
function server() {
  const handlers = new Map();
  const app = Object.fromEntries(['GET', 'PUT', 'POST', 'PATCH', 'DELETE'].map(method => [
    method.toLowerCase(), (path, fn) => handlers.set(method + ' ' + path, fn),
  ]));
  const deps = { db: () => null, dataDir: dir, staged: () => false, timeZone: () => 'America/Los_Angeles' };
  const source = registerSourceRoutes(app, {
    ...deps, secret: () => 'fake-test-secret', testMode: false,
    requireAdmin(req, res) {
      if (req.user?.role === 'admin') return req.user;
      res.status(403).json({ error: 'Forbidden' });
    },
  });
  registerInspectionRoutes(app, {
    ...deps, user: req => req.user, source: source.inspectionSource,
    people: () => [admin, coordinator, mashgiach], maxPhotoChars: 50, photoRe: /./,
  });
  return {
    ...source,
    async request(method, path, { user = admin, body = {}, id = ids[0] } = {}) {
      const res = { code: 200, headers: {},
        status(code) { this.code = code; return this; },
        set(key, value) { this.headers[key] = value; },
        json(value) { this.body = structuredClone(value); },
      };
      await handlers.get(method + ' ' + path)({ body: structuredClone(body), query: {}, user, params: { id, placeId: id } }, res);
      return res;
    },
  };
}
const until = async callback => {
  for (let i = 0; i < 250; i++) {
    const value = await callback();
    if (value) return value;
    await sleep(20);
  }
  assert.fail('Timed out waiting for test refresh');
};

try {
  const original = server();
  const request = original.request;
  const refresh = async (instance = original) => {
    clockOffset += 61_000;
    const result = await instance.request('POST', '/api/sources/refresh');
    assert.equal(result.code, 200);
    return result.body;
  };
  const getContacts = async (instance = original, id = ids[0], user = admin) => {
    const result = await instance.request('GET', airtablePath, { id, user });
    assert.equal(result.code, 200);
    assert.equal(result.headers['Cache-Control'], 'private, no-store');
    return result.body;
  };

  const testConnection = await request('POST', '/api/sources/test', { body: config });
  assert.deepEqual(testConnection.body.guess.mapping.contacts, contactsMapping);
  assert.equal(testConnection.body.samples.Contacts, undefined);
  for (const invalidLink of [
    field('Establishments', 'singleLineText'),
    field('Establishments', 'multipleRecordLinks', { linkedTableId: 'tblProducts' }),
  ]) {
    schema = [...core, { ...contactTable, fields: contactFields.map(f => f === link ? invalidLink : f) }];
    const test = await request('POST', '/api/sources/test', { body: config });
    assert.equal(test.body.guess.mapping.contacts, undefined);
    const bad = await request('PUT', connectionPath, { body: { ...config, mapping: { ...mapping, contacts: contactsMapping } } });
    assert.equal(bad.code, 400);
  }
  schema = [...core, contactTable];

  // Save an existing-style, three-list mapping. The contact schema is recognized automatically.
  assert.equal((await request('PUT', connectionPath, { body: config })).code, 200);
  const failed = await until(async () => {
    const result = await request('GET', airtablePath);
    return result.body?.status === 'error' && result.body;
  });
  assert.deepEqual(failed, { contacts: [], configured: true, status: 'error', lastReadAt: null });

  failContactAt = -1;
  assert.equal((await refresh()).ok, true);
  const readsBefore = requests.length;
  const contacts = await Promise.all(ids.map(id => getContacts(original, id)));
  assert.equal(requests.length, readsBefore, 'company screens read the cache only');
  assert.equal(new Set(contacts.flatMap(result => result.contacts.map(contact => contact.id))).size, 31);
  assert.deepEqual(contacts.map(result => result.contacts.length), [11, 11, 10]);
  assert.deepEqual(contacts[0].contacts[0], {
    id: 'recContact0', name: 'Airtable fallback', phone: '555-0199', email: 'airtable0@example.test',
    roles: ['Owner', 'Secondary Contact'], source: 'airtable',
  });
  assert.ok(!contacts[2].contacts.some(contact => contact.id === 'recContact0'));
  const snapshotFile = join(dir, 'source-connections', 'sourceContactSnapshots', 'testAgency.json');
  assert.doesNotMatch(await readFile(snapshotFile, 'utf8'), /Private notes|raw-contact-row-sentinel/);

  const appContact = { name: 'Shutfey contact', role: 'Manager', phone: '555-0123', email: 'app@example.test' };
  const baseline = await request('GET', infoPath);
  const saved = await request('PUT', infoPath, { body: { address: '2 Mock Street', phone: '555-0110',
    contacts: [appContact], contactsRevision: baseline.body.contactsRevision } });
  assert.equal(saved.code, 200);
  assert.equal((await request('PUT', '/api/inspections/schedule/companies/:id/people', {
    body: { mashgiachIds: [mashgiach.id], coordinatorIds: [coordinator.id] },
  })).code, 200);
  assert.equal((await getContacts(original, ids[0], coordinator)).contacts.length, 11);
  assert.deepEqual((await request('GET', infoPath, { user: coordinator })).body.contacts, saved.body.contacts);
  for (const path of [infoPath, airtablePath]) {
    assert.equal((await request('GET', path, { id: ids[1], user: coordinator })).code, 404);
    assert.equal((await request('GET', path, { user: person('admin', 'otherAgency') })).code, 404);
  }
  assert.equal((await request('PUT', infoPath, { user: coordinator })).code, 403);
  assert.deepEqual((await request('GET', infoPath, { user: mashgiach })).body,
    { address: '2 Mock Street', phone: '555-0110', contacts: [] });
  assert.deepEqual((await request('GET', '/api/visits/places/:placeId/info', { user: mashgiach })).body,
    { address: '2 Mock Street', phone: '555-0110' });
  assert.equal((await request('GET', airtablePath, { user: mashgiach })).code, 403);
  assert.equal((await request('GET', airtablePath, { user: null })).code, 403);

  rows.Contacts[0].fields['Phone Number'] = '555-0102';
  await refresh();
  assert.equal((await getContacts()).contacts[0].phone, '555-0102');
  rows.Contacts[0].fields.Establishments = [ids[1]];
  rows.Contacts.splice(3, 1);
  await refresh();
  const lastGood = await getContacts();
  assert.ok(lastGood.lastReadAt);
  assert.ok(!lastGood.contacts.some(contact => ['recContact0', 'recContact3'].includes(contact.id)));
  assert.equal((await getContacts(original, ids[1])).contacts[0].phone, '555-0102');

  rows.Contacts.find(contact => contact.id === 'recContact6').fields['Phone Number'] = '555-0103';
  rows.Establishments[0].fields['Annual Fee'] = 550;
  rows.Ingredients[0].fields.Name = 'Sea salt';
  rows.Products[0].fields.Name = 'New crackers';
  failContactAt = 11;
  assert.equal((await refresh()).ok, true, 'failed contact pagination leaves the core refresh healthy');
  const coreData = original.inspectionSource(admin.agencyId);
  assert.equal(coreData.state.status, 'ok');
  assert.equal(coreData.state.companies[0].companyFee, 550);
  assert.equal(coreData.items(ids[0], 'ingredient')[0].name, 'Sea salt');
  assert.equal(coreData.items(ids[0], 'product')[0].name, 'New crackers');
  const stale = { ...lastGood, status: 'stale', timeZone: 'America/Los_Angeles' };
  assert.deepEqual(await getContacts(), stale);
  assert.deepEqual((await request('GET', infoPath)).body.contacts, saved.body.contacts);

  outage = true;
  const restarted = server();
  await restarted.boot();
  const restored = await until(async () => {
    const result = await restarted.request('GET', airtablePath);
    return result.body?.status === 'stale' && result.body;
  });
  assert.deepEqual(restored, stale, 'startup restores the snapshot even when all Airtable calls fail');

  outage = false;
  failContactAt = -1;
  rows.Contacts = [];
  assert.equal((await refresh(restarted)).ok, true);
  const empty = await getContacts(restarted);
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.contacts, []);
  failContactAt = 0;
  await refresh(restarted);
  assert.deepEqual(await getContacts(restarted), { ...empty, status: 'stale', timeZone: 'America/Los_Angeles' });
  const restartedEmpty = server();
  await restartedEmpty.boot();
  await until(async () => (await restartedEmpty.request('GET', airtablePath)).body?.status === 'stale');
  assert.deepEqual(await getContacts(restartedEmpty), { ...empty, status: 'stale', timeZone: 'America/Los_Angeles' });

  schema = core;
  assert.equal((await refresh(restartedEmpty)).ok, true);
  assert.deepEqual(await getContacts(restartedEmpty), { contacts: [], configured: false, status: 'not_configured', lastReadAt: null });
  assert.equal((await restartedEmpty.request('GET', connectionPath)).body.status, 'ok');
  console.log('Airtable contacts: strict schema, 31 paginated records, role scope, independent refresh, and durable empty and stale snapshots passed');
} finally {
  globalThis.fetch = originalFetch;
  Date.now = clock;
  await rm(dir, { recursive: true, force: true });
}
