import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentFixture, fixturePdf } from './airtable-document-fixture.mjs';
import { shiftFixture } from './test-101-shifts-crud.mjs';

export async function documentCases(baseUrl,ctx) {
  await reviewDuplicateAdd(baseUrl,ctx);
  const {api,tokens,people} = await shiftFixture(baseUrl,ctx,'115documents');
  const fake = await documentFixture();
  const root = '/api/sources/companies/recAhlstrom';
  const list = root+'/items/ingredients', item = list+'/recIngredient0', product = root+'/items/products/recProduct0';
  const settings = {sourceType:'airtable',baseId:fake.baseId,apiKey:fake.key,access:'readwrite',mapping:fake.mapping};
  const call = async (method,path,body,role='admin',status=200) => {
    const result = await api(role,method,path,body);
    assert.equal(result.status,status,method+' '+path+' '+JSON.stringify(result.json)); return result.json;
  };
  const doc = item+'/documents';
  const pdf = fixturePdf();
  async function upload(path,b,who,extra={},bytes=pdf,op=randomUUID()) {
    const r = await fetch(baseUrl+path,{method:'POST',headers:{
      Authorization:'Bearer '+tokens[who], 'Content-Type':'application/pdf','X-Operation-Id':op,
      'X-Base-Id':b.baseId,'X-Connection-Updated-At':b.updatedAt,'X-Attachment-Ids':JSON.stringify(b.attachmentIds),
      'X-Pdf-Name':'Updated.pdf',...extra},body:bytes});
    return {status:r.status,...await r.json()};
  }
  try {
    await call('POST','/api/__test__/sources-api-base',{url:fake.apiBase});
    await call('POST','/api/__test__/sources-api-base',{url:fake.contentBase,provider:'airtableContent'});
    await call('PUT','/api/sources/connection',settings);
    const snapshot = await call('GET',root+'/items');
    assert.equal(snapshot.ingredients.length,29); assert.equal(snapshot.products.length,26);
    assert.equal(snapshot.attachments[0].filename,'Letter Of Certification.pdf');
    assert.equal(snapshot.ingredients[0].certifyingAgency,'cRc'); assert.equal(snapshot.ingredients[1].certifyingAgency,undefined);
    assert.ok(snapshot.ingredients.every(i => i.attachments.length === 1));
    assert.equal(snapshot.products[0].certifyingAgency,undefined);
    assert.ok(!JSON.stringify(snapshot).includes('airtableusercontent'));
    await call('PUT','/api/inspections/schedule/companies/recAhlstrom/people',{mashgiachIds:[people.mash.id],coordinatorIds:[people.coord.id]});
    await call('GET',doc,undefined,'coordOff',403);
    await call('GET',root+'/items',undefined,'foreign',403);
    await call('GET',root.replace('recAhlstrom','recOther')+'/documents',undefined,'coord',403);
    assert.equal((await call('GET',root+'/items',undefined,'mash')).ingredients[0].attachments,undefined);
    const companyDoc = await call('GET',root+'/documents',undefined,'coord');
    const opened = await call('GET',root+'/documents/attLOC/open',undefined,'coord');
    assert.notEqual(opened.url,(await call('GET',root+'/documents/attLOC/open',undefined,'coord')).url);
    assert.equal((await upload(doc,companyDoc,'mash')).status,403);
    await call('PATCH',product,{fields:{name:'invalid'}},'coord',403);
    assert.equal(fake.state.uploads+fake.state.patches.length,0);
    const edit = await call('GET',item+'/edit');
    const binding = {baseId:edit.baseId,updatedAt:edit.updatedAt};
    const change = (fields,originals=edit.fields) => ({...binding,fields,originals});
    await call('PATCH',item,change({name:'Changed',certification:'KF'},{name:'stale',certification:'cRc'}),'admin',409);
    await call('PATCH',item,change({status:'invalid'}),'admin',400);
    await call('PATCH',item,change({expiresOn:'2027-02-30'}),'admin',400);
    await call('PATCH',item,change({locAttachment:'invalid'}),'admin',400);
    await call('PATCH',product,change({symbolRequired:'true'}),'admin',400);
    assert.equal(fake.state.patches.length,0);
    await call('PATCH',item,change({certification:'KF',name:edit.fields.name}));
    assert.deepEqual(fake.state.patches.at(-1).fields,{Certification:'KF'});
    const p = await call('GET',product+'/edit');
    await call('PATCH',product,change({symbolRequired:false,code:'000011'},p.fields));
    assert.deepEqual(fake.state.patches.at(-1).fields,{Symbol:false,UPC:'000011'});
    await call('POST',item+'/unlink',{...binding,companyIds:['recAhlstrom']},'admin',409);
    await call('POST',item+'/unlink',{...binding,companyIds:edit.companyIds});
    assert.deepEqual(fake.state.patches.at(-1).fields.Establishment,['recOther']);
    await call('GET',doc,undefined,'coord',403);
    assert.ok((await call('GET',list+'/add')).existing.some(i => i.id==='recIngredient0'));
    await call('POST',item+'/restore',{...binding,companyIds:['recOther']});
    const add = {...change({name:'Added ingredient'}),operationId:randomUUID()};
    fake.state.rejectCreate = true;
    await call('POST',list,{...add,fields:{name:'Rejected ingredient'}},'admin',422);
    fake.state.rejectCreate = false;
    const created = await call('POST',list,add);
    assert.equal((await call('POST',list,add)).recordId,created.recordId);
    assert.equal(fake.state.creates,1);
    assert.deepEqual(fake.rows['Ingredients List'].at(-1).fields.Establishment,['recAhlstrom']);
    fake.state.loseCreate=true;
    const uncertainAdd = {...add,fields:{name:'Lost ingredient'},operationId:randomUUID()};
    for (let i=0;i<2;i++) assert.match((await call('POST',list,uncertainAdd,'admin',409)).error,/may have created/);
    assert.equal(fake.state.creates,2);
    const reopened = await call('GET',list+'/add?operationId='+uncertainAdd.operationId);
    assert.equal(reopened.pending.name,'Lost ingredient');
    assert.equal(reopened.pending.recordId,undefined);
    const candidate = reopened.linked.find(row => row.name === reopened.pending.name);
    const accepted = await call('POST',list+'/reconcile',{...binding,decision:'accept',operationId:uncertainAdd.operationId,recordId:candidate.id,
      reviewedIds:[candidate.id],duplicatesAcknowledged:true});
    assert.equal(accepted.recordId,candidate.id);
    assert.equal(fake.state.creates,2);
    const another = {...uncertainAdd,operationId:randomUUID(),fields:{name:'Abandoned ingredient'}};
    await call('POST',list,another,'admin',409);
    const abandoned = await call('POST',list+'/reconcile',{...binding,decision:'abandon',operationId:another.operationId});
    assert.ok(abandoned.abandoned);
    assert.equal((await call('GET',list+'/add?operationId='+another.operationId)).pending,null);
    assert.equal(fake.rows['Ingredients List'].at(-1).fields.Name,'Abandoned ingredient');
    fake.state.loseCreate=false;
    const b = await call('GET',doc,undefined,'coord');
    assert.equal((await upload(doc,b,'coord',{},Buffer.alloc(5242881))).status,413);
    assert.equal((await upload(doc,b,'coord',{},Buffer.from('not a pdf'))).status,400);
    assert.equal((await upload(doc,b,'coord',{'X-Attachment-Ids':'[]'})).error,'These certificates changed in Airtable. Reload and review before replacing a file.');
    assert.equal(fake.state.uploads,0);
    const uploadId = randomUUID();
    fake.state.rejectUpload = true;
    assert.equal((await upload(doc,b,'coord',{},pdf,uploadId)).status,422);
    fake.state.rejectUpload = false;
    const replaced = await upload(doc,b,'coord',{'X-Replace-Id':'attCert0'},pdf,uploadId);
    assert.equal(replaced.saved,true,JSON.stringify(replaced)); assert.equal(fake.state.uploads,1);
    assert.deepEqual(fake.state.patches.at(-1).fields.Attachments,[{id:'attNew1'}]);
    fake.state.concurrent=true;
    const race = await upload(doc,await call('GET',doc),'admin',{'X-Replace-Id':'attNew1'});
    assert.match(race.error,/previous PDF was kept/);
    const newer = await call('GET',doc);
    assert.deepEqual(newer.attachmentIds,['attNew1','attNew2','attConcurrent']);
    fake.state.loseUpload=true;fake.state.ambiguous=true;
    const op = randomUUID();
    for(let i=0;i<2;i++) assert.match((await upload(doc,newer,'admin',{},pdf,op)).error,/may have received/);
    assert.equal(fake.state.uploads,3);
    fake.state.failConfirm=true;
    assert.equal((await call('PATCH',product,change({code:'1212'},{code:'000011'}),'admin',409)).error,'Airtable may have saved these changes. Reload and review before retrying.');
    fake.state.failConfirm=false;fake.state.failList=true;
    assert.equal((await call('PATCH',product,change({code:'1212'},{code:'000011'}))).warning,'Saved in Airtable. Refresh required.');
    const offline = await call('GET',root+'/items');assert.ok(offline.savedAt);assert.equal(offline.status,'stale');
    assert.equal(offline.recovery,true);
    const recovered = await call('GET',product+'/edit');
    assert.equal(recovered.fields.code,'1212');
    await call('GET',list+'/add',undefined,'admin',503);
    fake.state.failList=false;
    const patchCount = fake.state.patches.length;
    assert.equal((await call('PATCH',product,change({code:'1212'},recovered.fields))).saved,true);
    assert.equal(fake.state.patches.length,patchCount);
    assert.equal((await call('GET',root+'/items')).status,'ok');
    await call('PUT','/api/sources/connection',{...settings,access:'read',mapping:{...fake.mapping,companies:{...fake.mapping.companies,address:'LOC'}}});
    await call('GET',doc,undefined,'coord');
    assert.equal((await upload(doc,newer,'coord')).status,403);
    await call('PUT','/api/sources/access',{access:'readwrite'});
    const tolerant = await call('GET','/api/sources/rows/companies/recAhlstrom/edit');
    assert.equal('address' in tolerant.fields,false); assert.ok(tolerant.warnings.length);
    fake.tables[0].fields.find(f => f.name==='Name').type='multipleAttachments';
    await call('GET','/api/sources/rows/companies/recAhlstrom/edit',undefined,'admin',409);
  } finally { await fake.close(); }
}

async function reviewDuplicateAdd(baseUrl,ctx) {
  const {api} = await shiftFixture(baseUrl,ctx,'115duplicateAdd');
  const fake = await documentFixture();
  const list = '/api/sources/companies/recAhlstrom/items/ingredients';
  async function call(method,path,body,status=200) {
    const result = await api('admin',method,path,body);
    assert.equal(result.status,status,method+' '+path+' '+JSON.stringify(result.json));
    return result.json;
  }
  try {
    await call('POST','/api/__test__/sources-api-base',{url:fake.apiBase});
    await call('PUT','/api/sources/connection',{sourceType:'airtable',baseId:fake.baseId,apiKey:fake.key,access:'readwrite',mapping:fake.mapping});
    const {baseId,updatedAt,linked} = await call('GET',list+'/add');
    const older = linked[0];
    const binding = {baseId,updatedAt,operationId:randomUUID()};
    fake.state.loseCreate = true;
    await call('POST',list,{...binding,fields:{name:older.name}},409);
    const reopened = await call('GET',list+'/add?operationId='+binding.operationId);
    assert.equal(reopened.pending.recordId,undefined);
    const reviewedIds = reopened.linked.filter(row => row.name === older.name).map(row => row.id);
    assert.equal(reviewedIds.length,2);
    assert.ok(reviewedIds.includes(older.id));
    const accept = {...binding,decision:'accept',recordId:older.id};
    await call('POST',list+'/reconcile',{...accept,reviewedIds},409);
    await call('POST',list+'/reconcile',{...accept,duplicatesAcknowledged:true,reviewedIds:[older.id]},409);
    const newId = reviewedIds.find(id => id !== older.id);
    const accepted = await call('POST',list+'/reconcile',{...accept,recordId:newId,duplicatesAcknowledged:true,reviewedIds});
    assert.equal(accepted.recordId,newId);
    assert.equal(fake.state.creates,1);
  } finally { await fake.close(); }
}
