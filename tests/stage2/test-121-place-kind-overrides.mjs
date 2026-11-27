import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyPlace } from '../../src/server/inspections/food-service.ts';
import { shiftFixture } from './test-101-shifts-crud.mjs';
import { mockFlexibleAirtable, pilotBase, pilotKey, pilotMapping } from './airtable-flexible-cases.mjs';

const food = '/api/food-service';
const marked = food + '/marked';
const ids = rows => rows.map(row => row.id).sort();

export default {
  name: 'Test 121: per-venue factory and food service choices',
  whatItProves: 'Type defaults, both override directions, validation, legacy marking, schedules, fees, report shapes, and v2 source settings.',
  async run(baseUrl, ctx) {
    const cases = [
      ['Restaurant', [], {}, ['venue'], 'factory'],
      ['Factory', ['venue'], {}, [], 'food_service'],
      ['Unmapped', [], {}, [], 'factory'],
      ['Restaurant', ['venue'], {}, ['venue'], 'factory'],
      ['', [], { venue: {} }, [], 'food_service'],
    ];
    for (const [type, foodMarked, manual, factoryMarked, expected] of cases) {
      assert.equal(classifyPlace({ id: 'venue', type }, [' restaurant '], foodMarked, manual, factoryMarked), expected);
    }
    const { api } = await shiftFixture(baseUrl, ctx, '121');
    const request = async (method, path, body, status = 200, role = 'admin') => {
      const result = await api(role, method, path, body);
      assert.equal(result.status, status, JSON.stringify(result.json));
      return result.json;
    };
    const get = path => request('GET', path);
    const put = (path, body, status, role) => request('PUT', path, body, status, role);
    const records = [
      ['mill', 'Demo Mill', 'Factory'], ['sibling', 'Demo Mill East', 'Factory'],
      ['bistro', 'Demo Bistro', ' Restaurant '], ['diner', 'Demo Diner', 'Restaurant'],
      ['other', 'Demo Unmapped Venue', 'Seasonal'],
    ].map(([id, Name, Type]) => ({ id, fields: { Name, Type } }));
    const columns = { Companies: ['Name', 'Type'], Ingredients: ['Name', 'Company'], Products: ['Name', 'Company'] };
    const baseId = 'appTEST121';
    const mock = http.createServer((req, res) => {
      const table = new URL(req.url, 'http://localhost').pathname.split('/').at(-1);
      res.setHeader('Content-Type', 'application/json');
      assert.equal(req.method, 'GET');
      if (table === 'bases') return res.end(JSON.stringify({ bases: [{ id: baseId, permissionLevel: 'read' }] }));
      if (table === 'tables') return res.end(JSON.stringify({ tables: Object.entries(columns).map(([name, fields]) => ({ name, fields: fields.map(name => ({ name })) })) }));
      res.end(JSON.stringify({ records: table === 'Companies' ? records : [] }));
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const fakeSource = url => request('POST', '/api/__test__/sources-api-base', { url });
    async function waitForSource() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const source = await get('/api/sources/connection');
        if (source.status === 'ok') return source;
        assert.equal(source.status, 'never', source.error);
        await sleep(50);
      }
      assert.fail('The fake source cache did not load');
    }
    try {
      await fakeSource('http://127.0.0.1:' + mock.address().port);
      const mapping = {
        companies: { table: 'Companies', name: 'Name', type: 'Type', factoryValues: ['Factory'], foodServiceValues: ['Restaurant'] },
        ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' },
        products: { table: 'Products', name: 'Name', companyLink: 'Company' },
        group1Values: [],
      };
      await put('/api/sources/connection', { sourceType: 'airtable', baseId, access: 'read', apiKey: 'fake-key-121', mapping });
      await waitForSource();
      const initial = await get(food);
      assert.deepEqual(ids(initial.places), ['bistro', 'diner']);
      assert.deepEqual(ids(initial.candidates), ['mill', 'other', 'sibling']);
      assert.deepEqual(ids((await get('/api/factories')).companies), ['mill', 'other', 'sibling']);
      assert.deepEqual(ids((await get('/api/visits/factories')).companies), ['mill', 'other', 'sibling']);
      await get('/api/factories/other/items');

      const schedule = { kind: 'every', n: 7, unit: 'day', start: '2098-11-01' };
      const fees = { company: { amount: 1200, per: 'year' }, mashgiach: { amount: 42 } };
      await put('/api/inspections/schedule/companies/mill', { schedule });
      await put('/api/inspections/fees/mill', fees);
      const factoryUrl = '/api/visits/factories/mill';
      const foodUrl = '/api/visits/food-service/mill';
      const millSchedule = async () => (await get('/api/inspections/schedule')).companies.find(row => row.id === 'mill');
      const visit = await get(factoryUrl);
      const beforeSchedule = await millSchedule();
      const factoryReport = { companyId: 'mill', clientReportId: 'test-121-factory', startedAt: '2098-11-03T13:00:00Z', listVersion: visit.listVersion, marks: [], offList: [] };
      const past = await request('POST', '/api/visits/reports', factoryReport, 201);
      const manual = (await request('POST', food + '/places', { name: 'Demo Manual', address: '' }, 201)).place;

      await put(marked, { add: ['mill'], factoryAdd: [manual.id] }, 400);
      await put(marked, { factoryAdd: ['bistro', 'unknown'], remove: ['bistro'] }, 400);
      await put(marked, { factoryAdd: ['bistro'] }, 403, 'coord');
      await put(marked, { factoryAdd: ['bistro'] }, 403, 'mash');
      assert.deepEqual(ids((await get(food)).places), ['bistro', 'diner', manual.id].sort());
      await put(marked, { add: ['mill'], factoryRemove: ['mill'] });
      assert.deepEqual(ids((await get('/api/factories')).companies), ['other', 'sibling']);
      assert.deepEqual(ids((await get(food)).places), ['bistro', 'diner', 'mill', manual.id].sort());
      await request('GET', factoryUrl, undefined, 404);
      const foodVisit = await get(foodUrl);
      assert.equal(foodVisit.template, null);
      assert.deepEqual(foodVisit.fee, visit.fee);
      assert.deepEqual((await millSchedule()).schedule, beforeSchedule.schedule);
      await request('POST', '/api/visits/reports', { ...factoryReport, clientReportId: 'test-121-wrong-factory' }, 404);
      const checklist = (await request('POST', food + '/templates', { name: 'Demo Checklist', items: [] }, 201)).template;
      await put(food + '/places/mill/template', { templateId: checklist.id });
      const foodReport = { kind: 'food_service', companyId: 'mill', clientReportId: 'test-121-food', startedAt: factoryReport.startedAt, answers: [], note: '', templateId: checklist.id, templateVersion: checklist.version };
      const recent = await request('POST', '/api/visits/reports', foodReport, 201);

      await put(marked, { factoryAdd: ['mill', 'bistro'], remove: ['mill', 'bistro'] });
      const flipped = await get(food);
      assert.deepEqual(ids(flipped.places), ['diner', manual.id].sort());
      assert.equal(flipped.candidates.find(row => row.id === 'bistro').typeMatched, true);
      assert.deepEqual(ids((await get('/api/factories')).companies), ['bistro', 'mill', 'other', 'sibling']);
      assert.deepEqual((await get(factoryUrl)).fee, visit.fee);
      assert.deepEqual((await millSchedule()).schedule, schedule);
      await request('POST', '/api/visits/reports', { ...foodReport, clientReportId: 'test-121-wrong-food' }, 404);
      await put(marked, { remove: ['mill'] }, 400); // The legacy marked entry was cleared.
      await put(marked, { add: ['bistro'], factoryRemove: ['bistro'] });
      assert.equal((await get(food)).places.find(row => row.id === 'bistro').marked, false);
      await put(marked, { add: ['mill'] });
      assert.equal((await get(foodUrl)).template.id, checklist.id);
      await put(marked, { remove: ['mill'] });
      assert.equal((await get('/api/inspections/reports/' + past.report.id)).report.kind, 'factory');
      assert.equal((await get('/api/inspections/reports/' + recent.report.id)).report.kind, 'food_service');
      assert.deepEqual((await get('/api/sources/connection')).mapping, mapping);
    } finally {
      mock.close();
    }
    const pilot = await mockFlexibleAirtable();
    try {
      await fakeSource(pilot.url);
      pilot.schema[0].fields.push({ id: 'fldType', name: 'Type', type: 'singleLineText' });
      pilot.rows.tblFacilities[0].fields.fldType = ' Restaurant ';
      const mapping = structuredClone(pilotMapping);
      mapping.entities[0].fields.type = { fieldId: 'fldType', expectedType: 'singleLineText', writable: false };
      mapping.companies = { factoryValues: ['Factory'], foodServiceValues: ['Restaurant'] };
      await put('/api/sources/connection', { sourceType: 'airtable', baseId: pilotBase, access: 'read', apiKey: pilotKey, mapping });
      const saved = await waitForSource();
      assert.deepEqual(saved.mapping.companies.foodServiceValues, ['Restaurant']);
      assert.deepEqual(saved.mapping.companies.factoryValues, ['Factory']);
      const { places, candidates } = await get(food);
      assert.deepEqual(ids(places.filter(row => row.source === 'connected')), ['recCedar']);
      assert.deepEqual(ids(candidates), ['recBrook', 'recHarbor']);
      assert.deepEqual(pilot.patches, []);
    } finally {
      pilot.close();
    }
    return 'Both boards and report kinds, atomic validation, type siblings, manual protection, stable fees and schedule, legacy marks, and v2 mapping defaults';
  },
};
