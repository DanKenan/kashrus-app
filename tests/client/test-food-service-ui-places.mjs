import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';
import { FoodServiceScreen } from '../../src/components/FoodServiceScreen.tsx';
import { FoodChoice } from '../../src/components/ChecklistTemplatesScreen.tsx';
import { VisitScheduleEditor } from '../../src/components/VisitScheduleEditor.tsx';
import { previewRows } from '../../src/lib/sourcePreview.ts';
const company = { id: 'fs_test', name: ' Test place ', address: ' Test address ', type: '', source: 'manual', templateId: null, schedule: null, nextDue: null, lastVisit: null, status: 'none', overdueDays: 0, mashgiachIds: [], coordinatorIds: [], mute: null };
const data = { today: '2026-11-11', timeZone: 'UTC', settings: { countFrom: 'planned', mashgichimSeeAll: true }, people: { mashgichim: [], coordinators: [] }, templates: [], places: [company], candidates: [] };
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const calls = []; globalThis.fetch = async (url, opts = {}) => { calls.push([url, opts.method || 'GET', opts.body && JSON.parse(opts.body)]); return new Response(JSON.stringify(url.endsWith('/connection') ? { mapping: { companies: { foodServiceValues: [' Test food '] } } } : url.endsWith('/mute') ? { company: { ...company, mute: { until: null } } } : data)); };
const props = { role: 'admin', userId: 'test-u', agencyId: 'test-a', timeZone: 'UTC', onClose() {} };
const screen = mount(FoodServiceScreen, props); await screen.render(); assert.match(screen.text(), /No checklist/); await screen.click('Add a place');
const inputs = screen.find(e => e.type === 'input'); inputs[0].props.onChange({ target: { value: ' New test place ' } }); await screen.render(); screen.find(e => e.type === 'input')[1].props.onChange({ target: { value: ' Test address ' } }); await screen.render(); await screen.submit();
assert.deepEqual(calls.find(c => c[0] === '/api/food-service/places'), ['/api/food-service/places', 'POST', { name: ' New test place ', address: ' Test address ' }]);
const editor = mount(VisitScheduleEditor, { company, data, isAdmin: false, onSaved() {}, onClose() {} }); await editor.render();
assert.match(editor.text(), /Turning alerts off stops new-report and overdue notifications\. Problems found on a visit are always sent\./); assert.doesNotMatch(editor.text(), /Overdue alerts/);
await editor.click(e => e.props.children === 'Off'); assert.equal(editor.find(e => e.type === 'button' && e.props.children === 'Off')[0].props['aria-pressed'], true); await editor.submit(); assert.deepEqual(calls.find(c => c[0].endsWith('/mute')), ['/api/inspections/schedule/companies/fs_test/mute', 'PUT', { muted: true, until: null }]);
assert.equal(editor.find(e => e.type === 'input' && ['radio', 'checkbox'].includes(e.props.type)).length, 0);
const mapping = { companies: { table: 'test', name: 'name', type: 'type', factoryValues: ['Factory'], foodServiceValues: ['Food'] } };
const preview = previewRows({ test: [{ id: 'c', fields: { name: ' Test name ', type: ' Food ' } }] }, mapping, 'companies');
assert.deepEqual(preview.rows[0].slice(0, 4), [' Test name ', ' Food ', 'No', 'Yes']);
for (const file of ['src/lib/foodService.ts', ...['ChecklistTemplatesScreen', 'FoodServiceScreen', 'FoodServiceVisitScreen'].map(n => `src/components/${n}.tsx`)]) { const text = fs.readFileSync(file, 'utf8'); assert.doesNotMatch(text, /e\.g\.|\.where\(|\.orderBy\(|commitState\(/); }
const typedPlace = { ...company, id: 'test-typed', source: 'connected', type: ' TEST FOOD ' };
globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('/connection') ? { mapping: { companies: { foodServiceValues: [' Test food '] } } } : { ...data, places: [typedPlace] }));
const typed = mount(FoodServiceScreen, props); await typed.render();
assert.match(typed.text(), /Food service because of its type in your connected list/); assert.doesNotMatch(typed.text(), /Not food service/);
const typeLine = typed.find(e => e.type === 'p' && e.props.children === typedPlace.type)[0]; assert.ok(typeLine); assert.equal(typeLine.props.dir, 'auto'); assert.match(typeLine.props.className, /whitespace-pre-wrap break-words/);
for (const [typeMatched, marked, explanation] of [[false, true, false], [true, true, true]]) {
  globalThis.fetch = async (url, opts = {}) => { calls.push([url, opts.method || 'GET', opts.body && JSON.parse(opts.body)]); return new Response(JSON.stringify(url.endsWith('/connection') ? { mapping: { companies: { foodServiceValues: [' Test food '] } } } : { ...data, places: [{ ...typedPlace, type: typeMatched ? typedPlace.type : ' Test Other ', typeMatched, marked }] })); };
  const markedPlace = mount(FoodServiceScreen, props); await markedPlace.render();
  assert.equal(markedPlace.text().includes('Food service because of its type in your connected list'), explanation); assert.match(markedPlace.text(), /Not food service/);
  await markedPlace.click(e => e.props.children === 'Not food service');
  assert.deepEqual(calls.filter(c => c[0] === '/api/food-service/marked').at(-1)[2], { remove: [typedPlace.id] });
}
const coordinatorCalls = [];
globalThis.fetch = async url => { coordinatorCalls.push(url); return new Response(JSON.stringify({ ...data, places: [{ ...typedPlace, typeMatched: true, marked: false }] })); };
const coordinator = mount(FoodServiceScreen, { ...props, role: 'coordinator' }); await coordinator.render(); assert.match(coordinator.text(), /Food service because of its type in your connected list/); assert.doesNotMatch(coordinator.text(), /Not food service/); assert.ok(!coordinatorCalls.includes('/api/sources/connection'));
function collect(node, type) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(n => collect(n, type)); return [...(node.type === type ? [node] : []), ...collect(node.props?.children, type)]; }
const candidates = [{ id: 'test-factory', name: ' Test Factory Name ', type: ' Factory ' }, { id: 'test-other', name: ' Test Other Name ', type: ' Other Type ' }];
globalThis.fetch = async () => new Response(JSON.stringify({ ...data, candidates }));
const marking = mount(FoodServiceScreen, props); await marking.render(); await marking.click(e => e.props.children === 'Mark as food service');
const choices = () => collect(marking.tree(), FoodChoice);
assert.equal(choices().length, 2);
for (const [i, choice] of choices().entries()) { const lines = choice.props.children; assert.equal(lines[0].props.children, candidates[i].name); assert.equal(lines[1].props.children, candidates[i].type); for (const line of lines) { assert.equal(line.props.dir, 'auto'); assert.match(line.props.className, /whitespace-pre-wrap break-words block/); } }
const search = value => marking.find(e => e.type === 'input' && e.props.type === 'search')[0].props.onChange({ target: { value } });
search('oThEr TyPe'); await marking.render(); assert.equal(choices().length, 1); assert.equal(choices()[0].key, 'test-other');
search('factory name'); await marking.render(); assert.equal(choices().length, 1); assert.equal(choices()[0].key, 'test-factory');
search('missing'); await marking.render(); assert.equal(choices().length, 0);
console.log('food service places, indefinite mute, approved copy, source preservation and index-free guard: OK');
