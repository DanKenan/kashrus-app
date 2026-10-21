/**
 * Item 8a — agency data fields for branded addresses (#12), DATA ONLY.
 *
 * Pure helpers: normalisation, validation and fresh-doc uniqueness checks
 * for an agency's slug and custom domain, plus the one projection used at
 * every place an agency leaves the server. Nothing here routes by host,
 * verifies DNS, mints tokens or changes logins.
 *
 * Uniqueness is enforced by calling findSlugClash / findDomainClash INSIDE a
 * commitState mutator against freshDoc.agencies: the check and the write sit
 * in the same Firestore transaction on app-state/main, so two concurrent
 * claims of one slug or domain can never both commit.
 */

import crypto from 'crypto';

export type DomainStatus = 'none' | 'pending' | 'verified' | 'failed';

/** Fields only the server may write (never accepted from a request body). */
export const SERVER_ONLY_AGENCY_FIELDS = [
  'domainStatus',
  'domainVerificationToken',
  'domainVerifiedAt',
  'domainLastCheckedAt',
] as const;

export const RESERVED_SLUGS = new Set([
  'app', 'www', 'api', 'admin', 'connect', 'mail', 'shutfey', 'kiosk',
  'login', 'auth', 'static', 'assets', 'help', 'support', 'status',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

export function normalizeSlug(input: unknown): string {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

/** Returns an error message, or null when the (normalised) slug is valid. */
export function validateSlug(slug: string): string | null {
  if (!SLUG_RE.test(slug) || slug.includes('--')) {
    return 'The short address must be 3–40 characters: lowercase letters, digits and single hyphens, not starting or ending with a hyphen.';
  }
  if (RESERVED_SLUGS.has(slug)) return 'That short address is reserved. Please choose another.';
  return null;
}

/** Derive a slug candidate from an agency's short code or name (may be invalid). */
export function slugBase(shortCode?: string, name?: string): string {
  const raw = (shortCode && shortCode.trim()) || (name && name.trim()) || 'agency';
  let s = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 34)
    .replace(/-+$/g, '');
  if (s.length < 3) s = (s + '-agency').replace(/^-/, '');
  if (RESERVED_SLUGS.has(s)) s = `${s}-agency`;
  return s;
}

/** A unique, valid slug for a new agency (suffix -2, -3, … on clash). */
export function uniqueSlug(base: string, agencies: any[], selfId?: string): string {
  const b = validateSlug(base) === null ? base : slugBase(base);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? b : `${b.slice(0, 40 - String(n).length - 1)}-${n}`;
    if (validateSlug(candidate) === null && !findSlugClash(agencies, selfId || '', candidate)) return candidate;
  }
  return `${b.slice(0, 27)}-${crypto.randomBytes(6).toString('hex')}`;
}

export function normalizeDomain(input: unknown): string {
  if (typeof input !== 'string') return '';
  let d = input.trim().toLowerCase();
  if (d.endsWith('.')) d = d.slice(0, -1);
  return d;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Returns an error message, or null when the (normalised) domain is valid. */
export function validateDomain(domain: string): string | null {
  const bad = 'Enter a web address like app.youragency.org (no https://, no slashes).';
  if (!domain || domain.length > 253) return bad;
  if (/[\/:@\s?#]/.test(domain)) return bad;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => !LABEL_RE.test(l))) return bad;
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return bad; // IPv4-like
  if (domain === 'localhost' || domain.endsWith('.localhost')) return bad;
  if (domain === 'run.app' || domain.endsWith('.run.app')) {
    return 'That address belongs to the hosting provider and cannot be used.';
  }
  if (domain === 'shutfey.com' || domain.endsWith('.shutfey.com')) {
    return 'Shutfey addresses are assigned automatically and cannot be claimed here.';
  }
  return null;
}

export function validateBrandName(input: unknown): { value?: string; error?: string } {
  if (typeof input !== 'string') return { error: 'Brand name must be text.' };
  const v = input.trim();
  if (v.length > 80) return { error: 'Brand name must be 80 characters or fewer.' };
  return { value: v };
}

export function validateLogoUrl(input: unknown): { value?: string; error?: string } {
  if (typeof input !== 'string') return { error: 'Logo address must be text.' };
  const v = input.trim();
  if (!v) return { value: '' };
  if (v.length > 2048) return { error: 'Logo address is too long.' };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { error: 'Logo address must be a full https:// link.' };
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) {
    return { error: 'Logo address must be a full https:// link.' };
  }
  return { value: u.toString() };
}

export function findSlugClash(agencies: any[], selfId: string, slug: string): any | null {
  // Both sides normalised (a legacy stored "  My-Agency " clashes with "my-agency").
  const want = normalizeSlug(slug);
  return (agencies || []).find(
    (a: any) => a && a.id !== selfId && typeof a.slug === 'string' && want !== '' && normalizeSlug(a.slug) === want
  ) || null;
}

export function findDomainClash(agencies: any[], selfId: string, domain: string): any | null {
  const want = normalizeDomain(domain);
  return (agencies || []).find(
    (a: any) => a && a.id !== selfId && typeof a.customDomain === 'string' && want !== '' && normalizeDomain(a.customDomain) === want
  ) || null;
}

export function newDomainVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Apply a custom-domain change to an agency record (pure; returns a copy).
 * - same domain as now → unchanged (token NOT rotated);
 * - new domain → status 'pending', fresh token, verified/checked cleared;
 * - '' → every domain field removed, status 'none'.
 */
export function withCustomDomain(agency: any, domain: string, makeToken: () => string = newDomainVerificationToken): any {
  const current = typeof agency.customDomain === 'string' ? normalizeDomain(agency.customDomain) : '';
  if (domain === current && (domain === '' || agency.domainStatus)) return { ...agency };
  const next: any = { ...agency };
  delete next.domainVerifiedAt;
  delete next.domainLastCheckedAt;
  if (!domain) {
    delete next.customDomain;
    delete next.domainVerificationToken;
    next.domainStatus = 'none';
    return next;
  }
  next.customDomain = domain;
  next.domainStatus = 'pending';
  next.domainVerificationToken = makeToken();
  return next;
}

/** True only for a domain that a verifier has marked verified (fail closed). */
export function isVerifiedDomainFor(agency: any, host: string): boolean {
  return !!agency
    && agency.domainStatus === 'verified'
    && typeof agency.customDomain === 'string'
    && normalizeDomain(agency.customDomain) === normalizeDomain(host);
}

export const AGENCY_PUBLIC_FIELDS = [
  'id', 'name', 'shortCode', 'certificationSeal', 'region', 'contactPhone',
  'timeZone', 'slug', 'brandName', 'logoUrl',
] as const;

export const AGENCY_ADMIN_EXTRA_FIELDS = [
  'adminEmail', 'createdAt', 'customDomain', 'domainStatus',
  'domainVerifiedAt', 'domainLastCheckedAt',
] as const;

function pick(src: any, keys: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** What any signed-in user (or a public page) may see of an agency: explicit allowlist. */
export function agencyPublicProfile(agency: any): Record<string, any> {
  return pick(agency, AGENCY_PUBLIC_FIELDS);
}

/** What the agency's own admin sees: public profile + settings. Never the DNS proof value. */
export function agencyAdminView(agency: any): Record<string, any> {
  return pick(agency, [...AGENCY_PUBLIC_FIELDS, ...AGENCY_ADMIN_EXTRA_FIELDS]);
}

/** Remove every server-only domain field from a client-supplied object (copy). */
export function stripServerOnlyAgencyFields<T extends Record<string, any>>(input: T): T {
  if (!input || typeof input !== 'object') return input;
  const out: any = { ...input };
  for (const k of SERVER_ONLY_AGENCY_FIELDS) delete out[k];
  return out;
}

/**
 * The single agency a Host header may resolve to: only a VERIFIED domain,
 * and only when exactly one agency holds it (ambiguity → null, fail closed).
 */
export function agencyIdForVerifiedHost(agencies: any[], host: string): string | null {
  const h = normalizeDomain(String(host || '').split(':')[0]);
  if (!h) return null;
  const hits = (agencies || []).filter((a: any) => isVerifiedDomainFor(a, h));
  return hits.length === 1 ? hits[0].id : null;
}
