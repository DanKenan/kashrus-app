import assert from 'node:assert/strict';
import { guardSourceWrite } from '../../src/server/sources/write.ts';
const mapping = { companies: { table: 'Companies', name: 'Name', address: 'Street', companyFee: 'Annual Fee' }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: '' }, group1Values: [] };
const c = { sourceType: 'google_sheets', access: 'readwrite', mapping };
assert.deepEqual({ ...guardSourceWrite(c, 'companies', { name: 'Demo Bakery', address: 'Demo Street' }) }, { Name: 'Demo Bakery', Street: 'Demo Street' });
for (const sourceType of ['airtable', 'upload'])
    assert.throws(() => guardSourceWrite({ ...c, sourceType }, 'companies', { name: 'Demo' }), e => e.status === 409);
for (const sourceType of ['google_sheets', 'excel', 'supabase'])
    assert.throws(() => guardSourceWrite({ ...c, sourceType, access: 'read' }, 'companies', { name: 'Demo' }), e => e.status === 403);
for (const list of ['reports', 'fees', 'oauth', 'products'])
    assert.throws(() => guardSourceWrite(c, list, { name: 'Demo' }), e => e.status === 400);
for (const fields of [{ unknown: 'demo' }, { file: 'secret' }, { pk: 'id' }, { name: 5 }, { name: 'x'.repeat(2001) }, null, {}, []])
    assert.throws(() => guardSourceWrite(c, 'companies', fields), e => e.status === 400);
console.log('single write guard restricts providers, access, lists and mapped columns');
