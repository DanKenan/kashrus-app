import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { CompanyItemLists } from '../../src/components/CompanyItemLists.tsx';
import { CertificatePanel } from '../../src/components/CertificatePanel.tsx';
import { CompanyItemEditor } from '../../src/components/CompanyItemEditor.tsx';

globalThis.document = {activeElement:null,addEventListener(){},removeEventListener(){}};
globalThis.localStorage = globalThis.sessionStorage = {getItem(){return null;}};
const attachment = {id:'attLOC',filename:'Letter Of Certification.pdf',size:60,contentType:'application/pdf'};
let calls = [];
const snapshot = {attachments:[attachment],company:{name:'Ahlstrom',type:'Factory'},access:'readwrite',sourceType:'airtable',status:'ok',
  ingredients:Array.from({length:29},(_,i)=>({id:'recI'+i,name:'Ingredient '+i,certifyingAgency:i===0?'cRc':undefined,attachments:[attachment]})),
  products:Array.from({length:26},(_,i)=>({id:'recP'+i,name:'Product '+i,statusRaw:'Pareve | Passover',code:'0123',symbolRequired:true}))};
globalThis.fetch = async (url,options) => {calls.push(url);return Response.json(snapshot);};
const props = {companyId:'recA',role:'admin',revision:0,onSaved(){}};
const list = await mount(CompanyItemLists,props).render();
await list.click('View ingredients');
assert.equal(calls.length,1);
assert.match(list.html(),/Ingredients \(29\)/);
assert.match(list.html(),/Products \(26\)/);
assert.equal(list.html().split('cRc').length,2);
assert.match(list.html(),/No certification on file/);
await list.render({...props,role:'coordinator'});
assert.match(list.html(),/Replace PDF/);
assert.doesNotMatch(list.html(),/>Edit<|Add ingredient|Save company details/);
await list.render({...props,role:'mashgiach'});
assert.doesNotMatch(list.html(),/View PDF|Replace PDF/);
snapshot.status='stale';snapshot.savedAt='2026-11-24T18:22:00Z';
await list.render({...props,revision:1,timeZone:'America/New_York'});
assert.match(list.text(),/last saved list from Nov 24, 1:22 PM/);
assert.doesNotMatch(list.html(),/>Edit<|Add ingredient|Replace PDF/);

const b = {baseId:'appFake',updatedAt:'v1',companyIds:['recA','recB'],fields:{name:'Flour',status:'Pareve',symbolRequired:true},
  fieldTypes:{name:'singleLineText',status:'singleSelect',symbolRequired:'checkbox'},typeOptions:{status:['Pareve','Dairy']},warnings:[]};
let posts=0;
globalThis.fetch=async (url,opts) => {
  if (opts.method==='PATCH') {
    posts++;
    assert.deepEqual(JSON.parse(opts.body).fields,{name:'Draft'});
    return Response.json({error:'Airtable may have saved these changes. Reload and review before retrying.'},{status:409});
  }
  return Response.json(b);
};
const editor=await mount(CompanyItemEditor,{path:'/items/products',id:'recP',ingredient:false,onSaved(){},onClose(){}}).render();
assert.match(editor.text(),/visible to every linked company/);
assert.equal(editor.find(el=>el.type==='select').length,1);
assert.equal(editor.find(el=>el.props.type==='checkbox').length,1);
editor.find(el=>el.props.value==='Flour')[0].props.onChange({target:{value:'Draft'}});
await editor.render();await editor.click('Save changes');
assert.match(editor.text(),/Reload and review/);
assert.equal(editor.buttons().find(b=>b.label==='Save changes').el.props.disabled,true);
assert.equal(editor.find(el=>el.props.value==='Draft').length,1);
assert.equal(posts,1);

let sent;
globalThis.fetch=async (url,opts)=>{
  if(opts.method==='POST') { sent=opts;throw Error('Lost response'); }
  return Response.json({...b,configured:true,attachmentIds:['attLOC'],attachments:[attachment]});
};
const panel=await mount(CertificatePanel,{path:'/documents',files:[attachment],writable:true,company:true,onSaved(){}}).render();
await panel.click('Replace PDF');
const input=panel.find(el=>el.props.type==='file')[0];
input.props.onChange({target:{files:[{name:'big.pdf',size:5242881,type:'application/pdf'}]}});
await panel.render();assert.match(panel.text(),/maximum size is 5 MB/);
const file=new File(['%PDF-1.4'], 'new.pdf',{type:'application/pdf'});
input.props.onChange({target:{files:[file]}});await panel.render();await panel.click('Save changes');
assert.equal(sent.body,file);
assert.equal(sent.headers.get('X-Replace-Id'),'attLOC');
assert.match(panel.text(),/Airtable may have received this PDF/);
assert.ok(panel.buttons().find(b=>b.label==='Save changes').el.props.disabled);
console.log('Company item lists, role gates, typed edits, draft recovery and binary PDF controls passed.');

for (const decision of ['accept','abandon']) {
  let operationId, closed = false;
  const name = 'Calcium carbonate', recordId = 'recRecovered';
  globalThis.fetch = async (url,opts) => {
    if (url.endsWith('/reconcile')) {
      assert.deepEqual(JSON.parse(opts.body),{decision,...(decision==='accept' && {recordId,duplicatesAcknowledged:true,reviewedIds:[recordId]}),operationId,baseId:b.baseId,updatedAt:b.updatedAt});
      return Response.json(decision==='accept' ? {saved:true} : {abandoned:true});
    }
    if (opts.method==='POST') {
      operationId = JSON.parse(opts.body).operationId;
      throw Error('Lost Add response');
    }
    return Response.json({...b,fields:{name:null},addScope:['agency','actor','base','version'],
      pending:url.includes('?operationId='+operationId) ? {name} : null,linked:[{name,id:recordId}]});
  };
  const args = {path:'/items/ingredients',ingredient:true,onSaved(){},onClose(){closed=true;}};
  const add = await mount(CompanyItemEditor,args).render();
  await add.type('',name); await add.click('Save changes');
  const reopened = await mount(CompanyItemEditor,args).render();
  assert.match(reopened.text(),/Calcium carbonate · recRecovered/);
  assert.match(reopened.text(),/Accept linked record/);
  assert.match(reopened.text(),/Abandon Add/);
  if (decision === 'accept') {
    assert.ok(reopened.buttons().find(b => b.label === 'Accept linked record').el.props.disabled);
    reopened.find(el => el.props.type === 'checkbox')[0].props.onChange({target:{checked:true}});
    await reopened.render();
  }
  await reopened.click(decision==='accept' ? 'Accept linked record' : 'Abandon Add');
  assert.ok(closed);
  assert.doesNotMatch((await mount(CompanyItemEditor,args).render()).text(),/Abandon Add/);
}

globalThis.fetch = async () => Response.json({...snapshot,recovery:true});
await list.render({...props,revision:2});
assert.match(list.html(),/>Edit</);
assert.doesNotMatch(list.html(),/Add ingredient|Replace PDF/);
let saveCount = 0;
globalThis.fetch = async (url, opts) => {
  if (opts.method==='PATCH') {
    saveCount++;
    return Response.json(saveCount===1 ? {saved:true,refreshRequired:true,warning:'Saved in Airtable. Refresh required.'} : {saved:true});
  }
  return Response.json({...b,fields:{name:saveCount ? 'Confirmed' : 'Flour'}});
};
const recoveryEditor = await mount(CompanyItemEditor,{path:'/items/products',id:'recP',ingredient:false,onSaved(){},onClose(){}}).render();
await recoveryEditor.type('','Confirmed'); await recoveryEditor.click('Save changes');
assert.match(recoveryEditor.text(),/Saved in Airtable. Refresh required./);
await recoveryEditor.click('Reload and review');
assert.equal(recoveryEditor.find(el=>el.props.value==='Confirmed').length,1);
await recoveryEditor.click('Save changes');
assert.equal(saveCount,2);

let liveName = 'Original', patches = [];
globalThis.fetch = async (url, opts) => {
  if (opts.method === 'PATCH') {
    const body = JSON.parse(opts.body);
    patches.push(body.fields);
    liveName = body.fields.name;
    return Response.json({saved:true,refreshRequired:true,warning:'Saved in Airtable. Refresh required.'});
  }
  return Response.json({...b,fields:{name:liveName}});
};
const conflicted = await mount(CompanyItemEditor,{path:'/items/products',id:'recP',ingredient:false,onSaved(){},onClose(){}}).render();
await conflicted.type('','1212');
await conflicted.click('Save changes');
assert.match(conflicted.text(),/Saved in Airtable. Refresh required/);
liveName = '999999';
await conflicted.click('Reload and review');
await conflicted.click('Save changes');
assert.deepEqual(patches,[{name:'1212'}]);
assert.equal(liveName,'999999');
assert.match(conflicted.text(),/changed again in Airtable/);
assert.ok(conflicted.buttons().find(b => b.label === 'Save changes').el.props.disabled);
await conflicted.click('Use current Airtable values');
await conflicted.type('','Reviewed');
await conflicted.click('Save changes');
assert.equal(liveName,'Reviewed');
