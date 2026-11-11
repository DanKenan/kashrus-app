import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';
import { ChecklistEditor, FoodChoice } from '../../src/components/ChecklistTemplatesScreen.tsx';
const editor = mount(ChecklistEditor, { template: null, onSaved() {}, onClose() {} }); await editor.render();
const html = editor.html(); assert.match(html, /aria-label="Close"/); assert.match(html, /h-11 w-11/); assert.doesNotMatch(html, /type="(?:checkbox|radio)"/); assert.match(html, /Save checklist/);
if (process.env.FOOD_DESIGN_HTML) { const css = fs.readdirSync('dist/assets').find(n => /^index-.*\.css$/.test(n)); fs.writeFileSync(process.env.FOOD_DESIGN_HTML, `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="file://${process.cwd()}/dist/assets/${css}"></head><body>${html}</body></html>`); }
console.log('food service design floor, close target, native-control exclusion: OK');
