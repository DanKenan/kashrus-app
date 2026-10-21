/**
 * SO client test: the reset form tells the person that a new password signs
 * them out on their other devices (sign-out-on-reset plan v2, item 5).
 * Source-level check: the note sits in the step-3 (new password) block of
 * ForgotPasswordModal, with the agreed copy, and the modal still renders.
 *
 * Run: npx tsx tests/client/test-reset-signout-note.mjs
 */
import fs from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ForgotPasswordModal } from '../../src/components/ForgotPasswordModal.tsx';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }

const src = fs.readFileSync(new URL('../../src/components/ForgotPasswordModal.tsx', import.meta.url), 'utf8');
const step3 = src.indexOf('{step === 3 && (');
const note = src.indexOf('Setting a new password signs you out on your other devices.');
const nextBlock = src.indexOf('{step ===', step3 + 5);
ok('R1 copy present', note > 0);
ok('R2 note inside the step-3 block', step3 > 0 && note > step3 && (nextBlock < 0 || note < nextBlock));
ok('R3 one occurrence', src.split('signs you out on your other devices').length === 2);
let html = '';
try { html = renderToStaticMarkup(React.createElement(ForgotPasswordModal, { onClose() {}, onSuccess() {} })); } catch (e) { ok('R4 renders', false, e.message); }
ok('R4 renders (step 1)', html.includes('Reset Password'));
ok('R5 note not shown before the code is verified', !html.includes('signs you out'));

console.log(`reset-signout-note: ${passed}/${passed + failures} passed`);
if (failures) process.exit(1);
