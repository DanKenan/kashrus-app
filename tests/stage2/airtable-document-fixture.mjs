// Isolated two-host Airtable copy. All records and certificates are synthetic.
import http from 'node:http';
import assert from 'node:assert/strict';
export function fixturePdf() {
  const stream = 'BT /F1 18 Tf 48 720 Td (Ahlstrom - Letter of Certification) Tj ET';
  const objects = ['<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>',
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>', `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n';
  const offsets = [];
  for (const [index,obj] of objects.entries()) {
    offsets.push(text.length); text += `${index+1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = text.length;
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10,'0') + ' 00000 n \n').join('');
  return Buffer.from(text + `trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
}
export async function documentFixture() {
  const baseId = 'appDocumentFixture', key = 'fixture-only';
  const companies = 'Establishments', ingredients = 'Ingredients List', products = 'Schedule B';
  const mapping = { companies:{table:companies,name:'Name',address:'Address',type:'Type'}, ingredients:{table:ingredients,
    name:'Name',companyLink:'Establishment',certification:'Certification',status:'Status',expiresOn:'Expires',brand:'Brand'},
    products:{table:products,name:'Name',companyLink:'Establishment',code:'UPC',status:'Status',symbolRequired:'Symbol'},group1Values:['Group 1'] };
  const field = (name,type = 'singleLineText', options) => ({id:'fld'+name,name,type,options});
  const select = field('Status','singleSelect',{choices:['Pareve','Pareve | Passover','Dairy'].map(name => ({name}))});
  const link = field('Establishment','multipleRecordLinks',{linkedTableId:'tblC'});
  const tables = [
    {name:companies,id:'tblC',fields:[field('Name'),field('Type'),field('Address'),field('LOC','multipleAttachments')]},
    {name:ingredients,id:'tblI',fields:[field('Name','multilineText'),link,field('Certification'),select,field('Expires','date'),field('Brand'),field('Attachments','multipleAttachments')]},
    {name:products,id:'tblP',fields:[field('Name'),link,field('UPC'),select,field('Symbol','checkbox')]},
  ];
  let seq = 0;
  const file = (id,filename,size = 1200) => ({id, filename, size,type:'application/pdf',url:'https://fixture.airtableusercontent.com/'+id+'?expires='+ ++seq});
  const row = (id,fields) => ({id,fields});
  const names = ['Bleached kraft pulp','Calcium carbonate','Potato starch','Sodium bicarbonate'];
  const rows = {
    [companies]: [row('recAhlstrom',{Name:'Ahlstrom',Address:'12 Mill Road',Type:'Factory',LOC:[file('attLOC','Letter Of Certification.pdf')]}),row('recOther',{Name:'North Mill',Type:'Factory'})],
    [ingredients]: Array.from({length:29},(_,i) => row('recIngredient'+i,{Name:names[i] || 'Paper coating blend '+i, Brand:'North Mill',
      Establishment:i === 0 ? ['recAhlstrom','recOther'] : ['recAhlstrom'],Certification:i === 0 ? 'cRc' : i === 2 ? 'KF' : '',Status:'Pareve',
      Attachments:[file('attCert'+i,i===28 ? 'KosherCertification'+ 'AnnualReview'.repeat(10)+'.pdf' : 'Kosher Certification.pdf')]})),
    [products]:Array.from({length:26},(_,i) => row('recProduct'+i,{Name:i === 0 ? 'Greaseproof baking parchment' : 'Food wrap grade '+i,
      Establishment:['recAhlstrom'],Status:'Pareve | Passover',Symbol:true,UPC:String(810000010020+i)})),
  };
  const state = {uploads:0,creates:0,patches:[],reads:0};
  const listen = async handler => {
    const server = http.createServer(async (req,res) => {
      try {
        if (req.headers.authorization !== 'Bearer '+key) {res.writeHead(403); return res.end('{}');}
        const parts = new URL(req.url,'http://localhost').pathname.split('/').slice(1).map(decodeURIComponent);
        let data = ''; for await (const chunk of req) data += chunk;
        await handler(req,res,parts,data ? JSON.parse(data) : {});
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    return server;
  };
  const api = await listen((req,res,parts,body) => {
    const [,base,table,id] = parts;
    const send = value => res.end(JSON.stringify(value));
    if (base === 'meta') return send(parts.at(-1) === 'bases' ? {bases:[{id:baseId,permissionLevel:'edit'}]} : {tables});
    assert.equal(base,baseId);
    const records = rows[table];
    if (!records) {res.writeHead(404);return send({});}
    if (!id && req.method === 'POST') {
      if (state.rejectCreate) {res.writeHead(422); return send({});}
      state.creates++;
      const created = row('recCreated'+state.creates,body.fields);records.push(created);
      if (state.loseCreate) return req.socket.destroy();
      return send(created);
    }
    if (!id) {
      if (state.failList) {res.writeHead(503);return send({});}
      return send({records});
    }
    const current = records.find(r => r.id === id);
    if (!current) {res.writeHead(404); return send({});}
    if (req.method === 'PATCH') {
      state.patches.push({id,fields:body.fields});
      for (const [k,v] of Object.entries(body.fields)) {
        if (['LOC','Attachments'].includes(k)) {
          assert.ok(v.every(ref => Object.keys(ref).length === 1 && ref.id));
          current.fields[k] = v.map(ref => current.fields[k].find(f => f.id === ref.id));
        } else current.fields[k] = v;
      }
      state.lastPatch = id;
    } else {
      state.reads++;
      if (state.lastPatch === id && state.failConfirm) { res.writeHead(503);return send({}); }
      if (state.newUpload && state.raceTarget === id && ++state.postUploadReads === 2) {
        current.fields[state.newUpload].push(file('attConcurrent','External certificate.pdf'));
        delete state.raceTarget;
      }
      for (const k of ['LOC','Attachments']) for (const f of current.fields[k] ?? []) f.url = file(f.id,f.filename).url;
    }
    return send(current);
  });
  const content = await listen((req,res,parts,body) => {
    assert.equal(req.method,'POST'); assert.equal(parts[1],baseId); assert.equal(parts[4],'uploadAttachment');
    assert.equal(body.contentType,'application/pdf');
    if (state.rejectUpload) {res.writeHead(422); return res.end('{}');}
    const target = Object.values(rows).flat().find(r => r.id === parts[2]);
    const column = parts[3].replace(/^fld/,'');
    const size = Buffer.from(body.file,'base64').length;
    if (state.concurrent) {state.raceTarget = target.id; state.concurrent = false;}
    state.uploads++; state.newUpload = column; state.postUploadReads = 0;
    const files = target.fields[column] ||= [];
    files.push(file('attNew'+state.uploads, body.filename,size));
    if (state.ambiguous) files.push(file('attTwin'+state.uploads,body.filename,size));
    if (state.loseUpload) return req.socket.destroy();
    res.end(JSON.stringify(target));
  });
  const origin = server => 'http://127.0.0.1:'+server.address().port;
  return {baseId,key,mapping,rows,tables,state,apiBase:origin(api),contentBase:origin(content),
    close:() => Promise.all([api,content].map(s => new Promise(resolve => s.close(resolve))))};
}
