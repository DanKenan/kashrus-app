import assert from 'node:assert/strict';
import { planTaggedEdit, updateTaggedRow, verifyTaggedEdit } from '../../src/server/sources/tagged-row.ts';
import { companyLinkResolver } from '../../src/server/sources/mapping.ts';

const mapping = {
  companies: { table: 'Companies', pk: 'ID', name: 'Name', address: 'Address', companyFee: 'Fee', note: 'Note' },
  ingredients: { table: 'Items', companyLink: 'Companies', expiresOn: 'Expiry', certification: 'Cert' },
  products: { table: 'Products', symbolRequired: 'Symbol' },
};
const companies = [{ id: 'a', sourceKey: 'A1', name: 'Acme' }, { id: 'b', sourceKey: 'B1', name: 'Baker' }];
const links = { resolve: companyLinkResolver(companies), sourceKey: id => companies.find(c => c.id === id)?.sourceKey };
const target = { actorId: 'admin', agencyId: 'agency', spreadsheetId: 'test', section: 'companies', table: 'Companies', metadataId: 8, recordId: 'A1' };
const edit = { mapping, section: 'companies', idHeader: 'ID', fields: { name: 'New name', companyFee: 145, address: 'Road' }, links };
const snapshot = { recordId: 'A1', metadataId: 8, headers: ['ID','Name','Address','Fee','Note'],
  cells: [{ raw: 'A1' },{ raw: 'Old' },{ raw: 'Road' },{ raw: 120 },{ raw: 2, formula: '=1+1' }] };
for (const mode of ['ok','lost','wrong-readback','rejected']) {
  const row = structuredClone(snapshot), history = [];
  let writes = 0;
  const action = updateTaggedRow(edit, target, {
    read: async () => structuredClone(row),
    async applyIfCurrent(actual, changes) {
      assert.deepEqual(actual, target);
      assert.deepEqual(changes.map(c => c.header), ['Name','Fee']);
      writes++;
      if (mode === 'rejected') return 'rejected';
      // Model the contract required of an atomic provider when a column moves.
      [row.headers[1],row.headers[3]] = [row.headers[3],row.headers[1]];
      [row.cells[1],row.cells[3]] = [row.cells[3],row.cells[1]];
      for (const change of changes) row.cells[row.headers.indexOf(change.header)].raw = change.requested;
      if (mode === 'wrong-readback') row.cells[1].raw = '145';
      if (mode === 'lost') throw Error();
      return 'applied';
    },
  }, async entry => history.push(structuredClone(entry)));
  const outcome = mode === 'rejected' ? 'rejected' : mode === 'wrong-readback' ? 'unconfirmed' : 'confirmed';
  if (outcome === 'confirmed') {
    await action;
    assert.deepEqual(row.cells.map(c => c.raw), ['A1',145,'Road','New name',2]);
    assert.equal(row.cells[4].formula, '=1+1');
  } else await assert.rejects(action, /Refresh and review/);
  assert.equal(writes, 1);
  assert.deepEqual(history.map(h => h.outcome), ['attempted', outcome]);
  assert.equal(history[0].operationId, history[1].operationId);
  assert.deepEqual(history[0].previous, { name: 'Old', companyFee: 120 });
}
function plan(section, field, value, header, cell, options = {}) {
  const row = { ...snapshot, headers: ['ID',header], cells: [snapshot.cells[0],cell] };
  return planTaggedEdit({ ...edit, section, fields: { [field]: value }, ...options }, row);
}
assert.deepEqual(plan('companies','name','A\nB','Name',{raw:'A\r\nB'}), []);
assert.deepEqual(plan('companies','companyFee',200,'Fee',{raw:'$200.00'}), []);
assert.throws(() => plan('companies','pk','C1','ID',{raw:'A1'}));
assert.throws(() => plan('companies','name','Text','Name',{raw:'x',formula:'=A1'}), /Formula/);
assert.throws(() => plan('companies','note','x','Note',{raw:''}), /editable/);
assert.equal(plan('companies','note',true,'Note',{raw:'No'}, {customTypes:new Map([['note','boolean']])})[0].requested,'Yes');
assert.equal(plan('ingredients','expiresOn','2024-02-29','Expiry',{raw:45400,dateSerial:true})[0].requested,45351);
assert.throws(() => plan('ingredients','expiresOn','2025-02-29','Expiry',{raw:null}), /calendar/);
assert.throws(() => plan('ingredients','expiresOn','2025-01-01','Expiry',{raw:'01/12/2024'}), /ISO/);
assert.equal(plan('ingredients','certification','OU-D','Cert',{raw:'OU'})[0].requested,'OU-D');
assert.throws(() => plan('ingredients','dpm','meat','Cert',{raw:'OU'}), /editable/);
assert.deepEqual(plan('ingredients','companyLink',['b','a'],'Companies',{raw:'A1, B1'}), []);
assert.throws(() => plan('ingredients','companyLink',['unknown'],'Companies',{raw:'A1'}), /Unknown/);
assert.deepEqual(plan('products','symbolRequired',false,'Symbol',{raw:false}), []);
assert.equal(verifyTaggedEdit(snapshot,{...snapshot, recordId:'other'},'ID',[],links),false);
console.log('Typed tagged-row planning, verification, and audit lifecycle passed with a model provider.');
