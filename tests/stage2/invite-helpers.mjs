/**
 * Invites always on (Don 2026-10-22, "Agreed — invites-always-on"): the ONE
 * production way to add a team member is POST /api/users (a pending invite)
 * followed by the invitee accepting the link with their own password.
 *
 * inviteMember: just the admin's step (returns the invite link token).
 * acceptNew:    just the invitee's step (mode 'new').
 * inviteAndAccept: both; on success { status: 201, json: { user }, text } in
 *   the old POST /api/users shape (user = the inviting admin's GET /api/users
 *   view of the new row); a refusal returns the refusing step's { status, json, text }.
 */
let ipN = 0;
const ip = () => `10.251.${Math.floor(ipN / 250) % 250}.${(ipN++ % 250) + 1}`;

async function req(baseUrl, method, path, headers, body) {
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

export async function inviteMember(baseUrl, headers, body) {
  const { password: _ignored, ...inviteBody } = body || {};
  const r = await req(baseUrl, 'POST', '/api/users', headers, inviteBody);
  const token = r.status === 201 && r.json?.pending === true ? (/#t=([A-Za-z0-9_-]+)/.exec(r.json.link || '')?.[1] || null) : null;
  return { ...r, token };
}

export async function acceptNew(baseUrl, token, password) {
  return req(baseUrl, 'POST', '/api/invites/accept', { 'Content-Type': 'application/json', 'X-Forwarded-For': ip() }, { token, mode: 'new', password: password || 'stage2-member-pw-0' });
}

export async function inviteAndAccept(baseUrl, headers, body) {
  const inv = await inviteMember(baseUrl, headers, body);
  if (!inv.token) return inv;
  const acc = await acceptNew(baseUrl, inv.token, body?.password);
  if (acc.status !== 200) return acc;
  const list = await req(baseUrl, 'GET', '/api/users', headers);
  const rows = Array.isArray(list.json) ? list.json : (Array.isArray(list.json?.users) ? list.json.users : []);
  const email = String(body?.email || '').trim().toLowerCase();
  const user = rows.find((u) => u && String(u.email || '').toLowerCase() === email) || null;
  const json = { user };
  return { status: user ? 201 : 500, json, text: JSON.stringify(json), accept: acc.json, invite: inv.json };
}
