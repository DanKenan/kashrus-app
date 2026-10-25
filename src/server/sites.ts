/**
 * Per-agency custom addresses, PR A (domains plan v4, sections 2a-2c): host
 * classification. Pure helpers only (no Express, no Firestore); server.ts owns
 * the routes. stage4 imports this file under plain node.
 *
 * The host comes from the RAW Host header only (req.rawHeaders), never from
 * req.hostname or X-Forwarded-Host: with app.set('trust proxy', 1) Express
 * lets a client-sent X-Forwarded-Host decide req.hostname. The host only
 * selects a policy; it never authenticates anyone.
 *
 *   SHARED  = this service's own Cloud Run hosts (pinned below, no *.run.app
 *             wildcard), "<tag>---" + one of them (tagged revision URLs used by
 *             CUTOVER.md), and, off Cloud Run only (no K_SERVICE: tests and
 *             local dev), the loopback names with a port. Exactly today's
 *             behaviour on these hosts.
 *   SITE    = a host listed in APP_SITES ("host=agencyId;host=agencyId") whose
 *             entry is valid and whose agency exists. Only that agency's people.
 *   UNKNOWN = everything else (for example a custom domain that is mapped but
 *             not configured). Sign-in, sessions, sockets and kiosks refused.
 */

/** The service's exact Cloud Run hostnames (E0, read from Don's D0 output on 2026-10-23). */
export const SHARED_RUN_APP_HOSTS: readonly string[] = [
  'workers-collaborative-dashboard-1080260390009.us-east1.run.app',
  'workers-collaborative-dashboard-je3qe44lta-ue.a.run.app',
];

/** The shared Shutfey address every agency can use (Don: "stays for all agencies"). */
export const SHARED_ORIGIN = 'https://' + SHARED_RUN_APP_HOSTS[0];

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const TAG_PREFIX = /^([a-z0-9-]+)---(.+)$/;
const AGENCY_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

export type SiteMap = ReadonlyMap<string, string>; // host -> agencyId

export type SiteClass =
  | { kind: 'shared'; host: string }
  | { kind: 'site'; host: string; agencyId: string; origin: string }
  | { kind: 'unknown'; host: string | null };

function validLabel(l: string): boolean {
  return l.length >= 1 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && !l.startsWith('-') && !l.endsWith('-');
}

/** A lower-case DNS name (no trailing dot, no userinfo, no port), or null. */
export function normalizeDnsName(x: unknown): string | null {
  if (typeof x !== 'string' || !x || x.length > 253) return null;
  if (x.endsWith('.')) return null;
  const labels = x.split('.');
  if (labels.length < 2 || !labels.every(validLabel)) return null;
  return x;
}

/**
 * The host of one Host header value. DNS names compare case-insensitively, so
 * the value is lower-cased first (browsers already send it lower-case); then it
 * must be a strict DNS name. A port is accepted only when allowPort (off Cloud
 * Run); there the loopback names also count ("localhost:3470",
 * "127.0.0.1:3470", "[::1]:3470"). Anything else: null.
 */
export function normalizeHostValue(raw: unknown, opts: { allowPort: boolean }): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 260) return null;
  if (raw !== raw.trim()) return null;
  const v = raw.toLowerCase();
  if (v.includes('@') || v.includes('/') || v.includes('\\')) return null;
  let name = v;
  let port = '';
  const m = /^(.*):(\d{1,5})$/.exec(v);
  if (m) {
    if (!opts.allowPort) return null;
    const n = Number(m[2]);
    if (!(n >= 1 && n <= 65535) || String(n) !== m[2]) return null;
    name = m[1];
    port = ':' + m[2];
  }
  if (LOOPBACK_NAMES.includes(name)) return opts.allowPort ? name + port : null;
  if (name.includes(':') || name.includes('[')) return null;
  const dns = normalizeDnsName(name);
  return dns ? dns + port : null;
}

/** The single Host header from Node's rawHeaders ([name, value, name, value, ...]); null when absent or repeated. */
export function rawHostHeader(rawHeaders: unknown): string | null {
  if (!Array.isArray(rawHeaders)) return null;
  let found: string | null = null;
  let count = 0;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (typeof rawHeaders[i] === 'string' && rawHeaders[i].toLowerCase() === 'host') {
      count += 1;
      found = typeof rawHeaders[i + 1] === 'string' ? rawHeaders[i + 1] : null;
    }
  }
  return count === 1 ? found : null;
}

function hostName(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
}

/** SHARED: a pinned Cloud Run host, "<tag>---" + a pinned host, or (local only) a loopback name. */
export function isSharedHost(host: string, opts: { local: boolean }): boolean {
  if (SHARED_RUN_APP_HOSTS.includes(host)) return true;
  const t = TAG_PREFIX.exec(host);
  if (t && SHARED_RUN_APP_HOSTS.includes(t[2])) return true;
  if (opts.local && LOOPBACK_NAMES.includes(hostName(host))) return true;
  return false;
}

export type AppSitesEntry = { host: string; agencyId: string; ok: boolean; reason?: string };
export type AppSitesConfig = { sites: SiteMap; entries: AppSitesEntry[]; malformed: string[] };

/**
 * APP_SITES = "host=agencyId;host=agencyId". Rules (plan 2a):
 *  - a malformed entry is ignored (and reported in `malformed` for the log);
 *  - a host listed twice: ALL its entries are rejected and the host is UNKNOWN;
 *  - an entry naming a SHARED host is rejected and the host stays SHARED;
 *  - a port is accepted only when local (off Cloud Run).
 * Whether the agency exists is decided per request (agencies load after start),
 * see classifyHost / siteAgencyOk.
 */
export function parseAppSites(raw: unknown, opts: { local: boolean }): AppSitesConfig {
  const entries: AppSitesEntry[] = [];
  const malformed: string[] = [];
  const sites = new Map<string, string>();
  if (typeof raw !== 'string' || !raw.trim()) return { sites, entries, malformed };
  const parsed: Array<{ host: string; agencyId: string }> = [];
  for (const part of raw.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    const host = eq > 0 ? normalizeHostValue(p.slice(0, eq).trim(), { allowPort: opts.local }) : null;
    const agencyId = eq > 0 ? p.slice(eq + 1).trim() : '';
    if (!host || !AGENCY_ID_SHAPE.test(agencyId)) {
      malformed.push(p.slice(0, 120));
      continue;
    }
    parsed.push({ host, agencyId });
  }
  const counts = new Map<string, number>();
  for (const e of parsed) counts.set(e.host, (counts.get(e.host) || 0) + 1);
  for (const e of parsed) {
    if ((counts.get(e.host) || 0) > 1) entries.push({ ...e, ok: false, reason: 'host listed more than once' });
    else if (isSharedHost(e.host, opts)) entries.push({ ...e, ok: false, reason: 'shared host cannot be a site' });
    else {
      entries.push({ ...e, ok: true });
      sites.set(e.host, e.agencyId);
    }
  }
  return { sites, entries, malformed };
}

/** The scheme a site origin uses: https, except a local port-carrying test host (plain http on loopback). */
export function siteOrigin(host: string, opts: { local: boolean }): string {
  return (opts.local && /:\d+$/.test(host) ? 'http://' : 'https://') + host;
}

/**
 * Classify one request by its raw Host header. agencyExists is asked for a
 * SITE host's agency on every call (agencies load after start and can change);
 * an entry whose agency does not exist makes the host UNKNOWN.
 */
export function classifyHost(
  rawHeaders: unknown,
  cfg: { sites: SiteMap; local: boolean; agencyExists: (agencyId: string) => boolean },
): SiteClass {
  const raw = rawHostHeader(rawHeaders);
  const host = raw === null ? null : normalizeHostValue(raw, { allowPort: cfg.local });
  if (!host) return { kind: 'unknown', host: null };
  if (isSharedHost(host, { local: cfg.local })) return { kind: 'shared', host };
  const agencyId = cfg.sites.get(host);
  if (agencyId && cfg.agencyExists(agencyId)) return { kind: 'site', host, agencyId, origin: siteOrigin(host, { local: cfg.local }) };
  return { kind: 'unknown', host };
}

/**
 * Plan 2b: the trusted-origin list. SHARED origins exactly as today (APP_ORIGINS
 * or the default, computed by the caller with trustedOrigins()); when APP_SITES
 * has valid sites the default run.app origin is always kept and each site's
 * origin is added. With no sites the result is the shared list unchanged.
 */
export function originsWithSites(sharedTrusted: readonly string[], sites: SiteMap, opts: { local: boolean }): string[] {
  if (sites.size === 0) return [...sharedTrusted];
  const out = new Set(sharedTrusted);
  out.add(SHARED_ORIGIN);
  for (const host of sites.keys()) out.add(siteOrigin(host, opts));
  return Array.from(out);
}

/**
 * Plan 2d: what a stored passkey's rpId says about where it works. No rpId:
 * made before this metadata existed ("earlier"; never inferred from the
 * current request). A shared host: "shared". A configured site host (port
 * ignored, an RP ID has none): "site" with its agency. Anything else: "other".
 */
export function passkeyAddressKind(
  rpId: unknown,
  sites: SiteMap,
  opts: { local: boolean },
): { kind: 'earlier' | 'shared' | 'site' | 'other'; agencyId?: string } {
  if (typeof rpId !== 'string' || !rpId) return { kind: 'earlier' };
  if (isSharedHost(rpId, opts)) return { kind: 'shared' };
  for (const [host, agencyId] of sites) if (hostName(host) === rpId) return { kind: 'site', agencyId };
  return { kind: 'other' };
}

/**
 * FACEID2: does a stored passkey work on the address of THIS request? A passkey
 * works only on the host it was made on (its RP ID = that host's name, no port).
 * `here` is the raw-Host classification of the request (it only selects what the
 * list says; it authenticates nothing; X-Forwarded-Host is never read), so the
 * answer describes the host of the PAGE asking. An unknown host: never (checked
 * before any comparison). No rpId (made before rpIds were stored, when only the
 * shared run.app addresses existed): a COMPATIBILITY HEURISTIC, not exact -
 * counted as here on any shared host and never on a site host. Its only wrong
 * answer: an earlier passkey made on the OTHER run.app host counts as here
 * (the offer then stays off, as before this change; the menu can still add one).
 */
export function passkeyWorksHere(rpId: unknown, here: SiteClass): boolean {
  if (here.kind === 'unknown' || !here.host) return false;
  if (typeof rpId !== 'string' || !rpId) return here.kind === 'shared';
  return rpId === hostName(here.host);
}

export const SITE_NOT_SET_UP_BODY = {
  error: "This address isn't set up yet. Please use the Shutfey address.",
  code: 'SITE_NOT_SET_UP',
  sharedOrigin: SHARED_ORIGIN,
} as const;

export const WRONG_SITE_BODY = {
  error: 'This address is for another agency. Please sign in at the Shutfey address.',
  code: 'WRONG_SITE',
  sharedOrigin: SHARED_ORIGIN,
} as const;
