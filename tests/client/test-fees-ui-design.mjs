import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';
import { FeeChoice } from '../../src/components/FeesSheet.tsx';
import { FeesDialog } from '../../src/components/FeesDialog.tsx';
const files = ['FeesDialog', 'FeesSheet', 'FeesAccountantSettings', 'PayScreen', 'CompanyInfoSheet', 'PlaceInfoCard', 'ReportFeeCheck'];
for (const file of files) {
  const source = fs.readFileSync(`src/components/${file}.tsx`, 'utf8');
  assert.doesNotMatch(source, /(?:bg|text|border)-(?:amber|yellow|red|green|gray|slate|white|black)-?\d*|#[a-f\d]{3,8}\b/i, file);
  assert.doesNotMatch(source, /text-\[(?:[0-9]|1[01])px\]|text-lg|rounded-\[|duration-\d|placeholder=|defaultValue=/, file);
  assert.doesNotMatch(source, /[✓⚠]|>×</, `${file}: use lucide icons`);
}
const selected = mount(FeeChoice, { selected: true, children: 'Test choice', onClick() {} }); await selected.render(); assert.match(selected.html(), /aria-pressed="true"/); assert.match(selected.html(), /bg-ink/); assert.match(selected.html(), /lucide-check/);
const dialog = mount(FeesDialog, { title: 'Test sheet', onClose() {}, children: 'Test content' });
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} }; await dialog.render(); assert.match(dialog.html(), /aria-label="Close"/); assert.match(dialog.html(), /h-11 w-11/); assert.match(dialog.html(), /lucide-x/);
console.log('fees D1 tokens, typography, empty inputs, filled checked choices and accessible close: OK');
