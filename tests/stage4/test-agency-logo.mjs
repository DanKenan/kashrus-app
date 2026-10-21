/** Item 12 (S1) unit tests: src/server/agency-logo.ts (strict base64, magic-byte type, header dimensions, rev, cleanup rule). */
import { decodeLogo, strictBase64, sniffLogoMime, newLogoRev, logoDocId, logoDocDeletable, LOGO_ERRORS, LOGO_REV_RE, LOGO_MAX_BYTES } from '../../src/server/agency-logo.ts';
import { agencyPublicProfile, agencyAdminView, SERVER_ONLY_AGENCY_FIELDS } from '../../src/server/agency-fields.ts';
import { png, jpeg, webpLossless, webpExtended, webpLossy, SVG, GIF, HTML, b64 } from '../stage2/logo-fixtures.mjs';
let n = 0; const ok = (c, m) => { if (!c) throw new Error(m); n++; };
const J = JSON.stringify;
const run = async function () {
  // accepted types, dimensions from the header
  for (const [label, buf, mime, w, h] of [
    ['png', png(64, 32), 'image/png', 64, 32], ['png 256', png(256, 256), 'image/png', 256, 256],
    ['jpeg', jpeg(120, 40), 'image/jpeg', 120, 40], ['jpeg progressive', jpeg(200, 100, { progressive: true }), 'image/jpeg', 200, 100],
    ['webp VP8L', webpLossless(100, 50), 'image/webp', 100, 50], ['webp VP8X', webpExtended(256, 1), 'image/webp', 256, 1],
    ['webp VP8', webpLossy(30, 20), 'image/webp', 30, 20],
  ]) {
    const r = decodeLogo(b64(buf));
    ok(r.ok && r.logo.mime === mime && r.logo.width === w && r.logo.height === h, `${label}: ${J(r.ok ? { ...r.logo, bytes: r.logo.bytes.length } : r)}`);
  }
  // refused types: SVG, GIF, HTML, renamed SVG, random
  for (const [label, buf] of [['svg', SVG], ['gif', GIF], ['html', HTML], ['svg with png name', Buffer.concat([Buffer.from('<?xml version="1.0"?>'), SVG])], ['bytes', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]]) {
    const r = decodeLogo(b64(buf));
    ok(!r.ok && r.error === LOGO_ERRORS.type, `${label} refused as type: ${J(r)}`);
  }
  // dimensions
  for (const [label, buf] of [['png 257 wide', png(257, 10)], ['png 257 high', png(10, 257)], ['jpeg 300', jpeg(300, 10)], ['webp 257', webpExtended(257, 2)]]) {
    const r = decodeLogo(b64(buf));
    ok(!r.ok && r.error === LOGO_ERRORS.dims, `${label}: ${J(r)}`);
  }
  ok(!decodeLogo(b64(png(0, 10))).ok, 'zero width refused');
  ok(!decodeLogo(b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).ok, 'truncated png (no IHDR) refused');
  ok(!decodeLogo(b64(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).ok, 'jpeg without SOF refused');
  // size
  const big = png(200, 200, { noisy: true });
  ok(big.length > LOGO_MAX_BYTES, `fixture is big ${big.length}`);
  ok(decodeLogo(b64(big)).ok === false && decodeLogo(b64(big)).error === LOGO_ERRORS.size, '>100 KB refused');
  // strict base64
  const good = b64(png(8, 8));
  for (const [label, s] of [['data: prefix', `data:image/png;base64,${good}`], ['whitespace', good.slice(0, 8) + '\n' + good.slice(8)], ['url-safe', good.replace(/\+/g, '-').replace(/\//g, '_') + '-'], ['missing padding', good.replace(/=+$/, '')], ['empty', ''], ['not a string', 123], ['bad char', good.slice(0, -4) + 'A*A=']]) {
    ok(!decodeLogo(s).ok, `bad base64 refused: ${label}`);
  }
  ok(strictBase64(good) !== null && sniffLogoMime(strictBase64(good)) === 'image/png', 'good base64 decodes');
  // rev
  const bytes = png(16, 16);
  const r1 = newLogoRev(bytes), r2 = newLogoRev(bytes);
  ok(LOGO_REV_RE.test(r1) && LOGO_REV_RE.test(r2), `rev shape ${r1}`);
  ok(r1.slice(0, 12) === r2.slice(0, 12) && r1 !== r2, 'same bytes: same hash part, unique rev');
  ok(logoDocId('agency-a', r1) === `agency-a__${r1}`, 'doc id');
  // cleanup rule
  const now = Date.parse('2026-10-21T12:00:00Z');
  const old = new Date(now - 16 * 60000).toISOString(), young = new Date(now - 14 * 60000).toISOString();
  ok(logoDocDeletable({ rev: 'a', createdAt: old }, 'b', now), 'old, not current: deletable');
  ok(!logoDocDeletable({ rev: 'b', createdAt: old }, 'b', now), 'current: never deleted');
  ok(!logoDocDeletable({ rev: 'a', createdAt: young }, 'b', now), 'inside the grace: kept');
  ok(logoDocDeletable({ rev: 'a', createdAt: old }, null, now), 'no current logo: old docs deletable');
  ok(!logoDocDeletable({ rev: 'a', createdAt: 'nonsense' }, null, now) && !logoDocDeletable({ createdAt: old }, null, now), 'unreadable doc: kept');
  // projections: logoRev always present (string or null); server-only
  ok(agencyPublicProfile({ id: 'a', name: 'A' }).logoRev === null && 'logoRev' in agencyPublicProfile({ id: 'a' }), 'public profile: logoRev null when unset');
  ok(agencyPublicProfile({ id: 'a', logoRev: r1 }).logoRev === r1 && agencyAdminView({ id: 'a', logoRev: r1 }).logoRev === r1, 'projections carry the rev');
  ok(agencyAdminView({ id: 'a' }).logoRev === null, 'admin view: null when unset');
  ok(SERVER_ONLY_AGENCY_FIELDS.includes('logoRev'), 'logoRev is server-only');
  console.log(`agency-logo: ${n}/${n} passed`);
};
export default { name: 'agency logo (item 12, S1)', whatItProves: 'Logo uploads are strict base64, PNG/JPEG/WebP by magic bytes only (SVG/GIF/HTML refused), at most 100 KB and 256 px a side from the header; revs are unique per upload; cleanup never deletes the current or a young doc; projections always carry logoRev.', run };
