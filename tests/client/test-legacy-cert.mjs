/** Legacy stored certification text (Don, Oct 21 — Yosi's Kitchen): display-only reading in
 * CertificationBadge. (a) agency name twice joined by a dash -> no type picked; (b) '<agency> <dash>
 * <option>' -> that option; (c) anything else -> today's behaviour (stored text verbatim). */
import React from 'react';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CertificationBadge } from '../../src/components/CertificationBadge.tsx';
import { readCertification, DEFAULT_CERT_OPTIONS } from '../../src/lib/certOptions.ts';
let passed = 0;
function check(name, value, info = '') { assert.ok(value, name + (info ? ' :: ' + info : '')); passed++; }
const src = 'data:image/png;base64,YQ==';
const A = 'Hartford Kashrut Commission (HKC)';
const IMG = `<img src="${src}" alt="${A}" class="h-[20px] w-auto max-w-[80px] object-contain"/>`;
const badge = (p) => renderToStaticMarkup(React.createElement(CertificationBadge, { agencyName: A, agencyShortCode: 'HKC', iconClassName: 'icon', ...p }));
const strip = (h) => h.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');

// (a) the agency name twice, joined by any dash variant (trim + ignore case) -> no type picked.
for (const join of [' - ', ' — ', ' – ', '-', ' -', '- ', '  —  ', ' -  ']) {
  for (const second of [A, A.toUpperCase(), `  ${A.toLowerCase()} `]) {
    const stored = `${A}${join}${second}`;
    check(`(a) read ${JSON.stringify(join)} -> no type`, readCertification(stored, A) === '', String(readCertification(stored, A)));
    check(`(a) logo -> logo only ${JSON.stringify(join)}`, badge({ certification: stored, logoSrc: src }) === IMG, badge({ certification: stored, logoSrc: src }));
    const nl = badge({ certification: stored });
    check(`(a) no logo -> no-logo label (agency name) ${JSON.stringify(join)}`, nl.includes('<svg') && strip(nl) === A && !nl.includes('<img'), nl);
  }
}
check('(a) Yosi\'s Kitchen exact string -> logo only', badge({ certification: `${A} - ${A}`, logoSrc: src }) === IMG);
check('(a) blank stored detail still counts as no type', badge({ certification: `${A} - ${A}`, certificationDetail: '  ', logoSrc: src }) === IMG);
check('(a) a real stored detail beside a doubled name -> (c) verbatim', strip(badge({ certification: `${A} - ${A}`, certificationDetail: 'Dairy', logoSrc: src })) === `${A} - ${A}`);

// (b) '<agency> <dash> <detail>' where the detail is one of the agency's options.
for (const join of [' - ', ' – ', ' — ', '  -  ']) {
  for (const det of ['Glatt meat', 'glatt  MEAT', ' Glatt meat ']) {
    const stored = `${A}${join}${det}`;
    check(`(b) read ${JSON.stringify(stored)} -> 'Glatt meat'`, readCertification(stored, A) === 'Glatt meat', String(readCertification(stored, A)));
    const wl = badge({ certification: stored, logoSrc: src });
    check(`(b) logo + detail ${JSON.stringify(join)} ${JSON.stringify(det)}`, wl.startsWith(IMG) && strip(wl) === 'Glatt meat', wl);
    check(`(b) no logo -> short code wording`, strip(badge({ certification: stored })) === 'HKC — Glatt meat');
  }
}
check('(b) all built-in options are recognised', DEFAULT_CERT_OPTIONS.every((o) => readCertification(`${A} - ${o.toLowerCase()}`, A) === o));
check('(b) the agency\'s own saved option (passed in) is recognised', readCertification(`${A} - Yoshon`, A, '', ['Glatt meat', 'Yoshon']) === 'Yoshon');
check('(b) badge passes the caller\'s options through', strip(badge({ certification: `${A} – Yoshon`, certificationOptions: ['Yoshon'], logoSrc: src })) === 'Yoshon');
check('(b) stored detail that agrees with the legacy text -> consistent', strip(badge({ certification: `${A} - Glatt meat`, certificationDetail: 'Glatt meat', logoSrc: src })) === 'Glatt meat');
check('(b) stored detail that disagrees -> (c) verbatim', strip(badge({ certification: `${A} - Glatt meat`, certificationDetail: 'Dairy', logoSrc: src })) === `${A} - Glatt meat`);

// (c) anything else keeps today's behaviour: stored text verbatim, shield icon, no logo.
const verbatim = (stored, extra = {}) => { const h = badge({ certification: stored, logoSrc: src, ...extra }); return !h.includes('<img') && h.includes('<svg') && strip(h) === stored; };
check('(c) unknown detail (not an option)', verbatim(`${A} - Glatt Meat & Mehadrin`));
check('(c) a custom option not passed in', verbatim(`${A} - Yoshon`));
check('(c) another agency\'s name', verbatim('Some other agency - Some other agency'));
check('(c) another agency + an option', verbatim('Kof-K - Dairy'));
check('(c) no dash between name and detail', verbatim(`${A} Dairy`));
check('(c) unspaced dash before a detail stays verbatim (test-12 rule)', verbatim(`${A}— Dairy`) && verbatim(`${A}-Dairy`) && verbatim(`${A} –Dairy`));
check('(a) en/em dash without spaces is not form (a)', verbatim(`${A}—${A}`) && verbatim(`${A}–${A}`));
check('(c) agency name + dash with nothing after', verbatim(`${A} -`));
check('(c) a third dash part', verbatim(`${A} - Dairy - extra`));
check('(c) empty stored text', strip(badge({ certification: '', logoSrc: src })) === '');
check('(c) no agency name -> verbatim', strip(badge({ certification: `${A} - ${A}`, agencyName: undefined, logoSrc: src })) === `${A} - ${A}`);

// Today's forms are unchanged.
check('today: logo + no type -> logo only', badge({ certification: A, logoSrc: src }) === IMG);
check('today: no logo + no type -> shield + name', strip(badge({ certification: A })) === A && badge({ certification: A }).includes('<svg'));
check('today: logo + type', strip(badge({ certification: `${A} — Glatt meat`, certificationDetail: 'Glatt meat', logoSrc: src })) === 'Glatt meat');
check('today: em-dash label with no stored detail', strip(badge({ certification: `${A} — Parve`, logoSrc: src })) === 'Parve');
check('today: no logo + type -> short code', strip(badge({ certification: `${A} — Glatt meat`, certificationDetail: 'Glatt meat' })) === 'HKC — Glatt meat');
check('today: no short code -> stored label', strip(badge({ certification: `${A} — Glatt meat`, certificationDetail: 'Glatt meat', agencyShortCode: '' })) === `${A} — Glatt meat`);
check('today: label that is not the agency name stays verbatim', verbatim('Some other agency'));
check('today: renamed agency stays verbatim', strip(badge({ certification: A, agencyName: 'Renamed', logoSrc: src })) === A);
check('today: custom detail saved with an em dash (any text) still reads', strip(badge({ certification: `${A} — Yoshon`, certificationDetail: 'Yoshon', logoSrc: src })) === 'Yoshon');

console.log(`test-legacy-cert: ${passed}/${passed} passed`);
