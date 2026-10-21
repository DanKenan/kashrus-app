import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';

const MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const isMime = (x: unknown): x is typeof MIMES[number] => MIMES.includes(x as typeof MIMES[number]);
export const LOGO_CACHE_KEY = 'shutfey_agency_logo';
export function validRev(x: unknown): x is string { return typeof x === 'string' && x.length > 0 && x.length <= 64; }
export function isLogoFeatureOn(user: unknown): boolean {
  if (!user || typeof user !== 'object' || !Object.prototype.hasOwnProperty.call(user, 'agencyLogoRev')) return false;
  const rev = (user as { agencyLogoRev: unknown }).agencyLogoRev;
  return rev === null || typeof rev === 'string';
}
export function clearLogoCache(): void { try { localStorage.removeItem(LOGO_CACHE_KEY); } catch {} }

type Identity = { userId?: string; agencyId?: string; rev?: string | null };
const isDataUrl = (x: unknown): x is string => typeof x === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(x);
export function readLogoCache({ userId, agencyId, rev }: Identity): string | null {
  try {
    const raw = localStorage.getItem(LOGO_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (userId && agencyId && validRev(rev) && entry.userId === userId && entry.agencyId === agencyId && entry.rev === rev && isDataUrl(entry.dataUrl) && entry.dataUrl.length <= 140000) return entry.dataUrl;
  } catch {}
  clearLogoCache();
  return null;
}
export function writeLogoCache(identity: Identity, dataUrl: string): void {
  if (dataUrl.length > 140000) { clearLogoCache(); return; }
  try { localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify({ ...identity, dataUrl })); } catch {}
}
/** isCurrent guards both the displayed image and the single cache entry. */
export async function loadAgencyLogo(identity: Identity, isCurrent: () => boolean = () => true): Promise<string | null> {
  const { userId, agencyId, rev } = identity;
  const cached = readLogoCache(identity);
  if (!userId || !agencyId || !validRev(rev) || !isCurrent()) return null;
  if (cached) return cached;
  try {
    const res = await apiFetch(`/api/agency/logo?rev=${encodeURIComponent(rev)}`);
    if (!res.ok) return null;
    const body = await res.json();
    if (!isCurrent() || body?.rev !== rev || !isMime(body?.mime) || typeof body.data !== 'string') return null;
    const dataUrl = `data:${body.mime};base64,${body.data}`;
    if (!isDataUrl(dataUrl)) return null;
    writeLogoCache(identity, dataUrl);
    return dataUrl;
  } catch { return null; }
}
export function useAgencyLogo({ userId, agencyId, rev }: Identity): string | null {
  const identity = useRef<Identity>({});
  identity.current = { userId, agencyId, rev };
  const [loaded, setLoaded] = useState<{ userId: string; agencyId: string; rev: string; src: string } | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    const isCurrent = () => active && identity.current.userId === userId && identity.current.agencyId === agencyId && identity.current.rev === rev;
    void loadAgencyLogo({ userId, agencyId, rev }, isCurrent).then((src) => {
      if (isCurrent() && userId && agencyId && validRev(rev)) setLoaded(src ? { userId, agencyId, rev, src } : null);
    });
    return () => { active = false; };
  }, [userId, agencyId, rev]);
  return userId && agencyId && validRev(rev) && loaded?.userId === userId && loaded.agencyId === agencyId && loaded.rev === rev ? loaded.src : null;
}

export interface LogoImage { data: string; mime: string; dataUrl: string; width: number; height: number }
interface ResizeDeps {
  decode?: (file: File) => Promise<{ width: number; height: number; source: CanvasImageSource; close?: () => void }>;
  createCanvas?: () => HTMLCanvasElement;
}
async function decode(file: File): Promise<{ width: number; height: number; source: CanvasImageSource; close?: () => void }> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Couldn't read that image.")); image.src = url; });
    return { width: image.naturalWidth, height: image.naturalHeight, source: image };
  } finally { URL.revokeObjectURL(url); }
}
export async function resizeForLogo(file: File, deps: ResizeDeps = {}): Promise<LogoImage> {
  if (!isMime(file.type)) throw new Error('Use a PNG, JPEG or WebP image.');
  const image = await (deps.decode || decode)(file);
  try {
    if (!(image.width > 0 && image.height > 0)) throw new Error("Couldn't read that image.");
    const scale = Math.min(1, 256 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = (deps.createCanvas || (() => document.createElement('canvas')))();
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error("Couldn't read that image.");
    context.drawImage(image.source, 0, 0, width, height);
    const attempts: [string, number?][] = [['image/webp', .9], ['image/webp', .8], ['image/webp', .7], ['image/png'], ['image/jpeg', .85], ['image/jpeg', .7], ['image/jpeg', .6]];
    for (const [mime, quality] of attempts) {
      const dataUrl = canvas.toDataURL(mime, quality);
      // Unsupported encoders may silently return PNG; only accept the requested format.
      if (!dataUrl.startsWith(`data:${mime};base64,`)) continue;
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const bytes = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      if (bytes <= 102400) return { data, mime, dataUrl, width, height };
    }
    throw new Error('That image is too large. Try a smaller or simpler image.');
  } finally { image.close?.(); }
}

/** Live fix (Oct 21): a session restored from localStorage (saved before #97)
 * has no agencyLogoRev, so the logo feature stays hidden until the next login.
 * The server's roster rows (INITIAL_STATE / USERS_UPDATED) carry the user's own
 * row with the fresh agency fields; copy just those onto the signed-in user.
 * Only fields the row actually has are copied (a kiosk roster row has none).
 * Returns prev itself when nothing changes. */
const SELF_AGENCY_FIELDS = ['agencyLogoRev', 'agencyName', 'agencyShortCode', 'agencySeal', 'agencyTimeZone'] as const;
export function withFreshAgencyFields<T extends { id: string }>(prev: T | null, rows: unknown): T | null {
  if (!prev || !Array.isArray(rows)) return prev;
  const self = rows.find((r) => r && typeof r === 'object' && (r as { id?: unknown }).id === prev.id) as Record<string, unknown> | undefined;
  if (!self) return prev;
  let next: T | null = null;
  for (const key of SELF_AGENCY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(self, key)) continue;
    const value = self[key];
    if (key === 'agencyLogoRev' && value !== null && !validRev(value)) continue;
    const had = Object.prototype.hasOwnProperty.call(prev, key);
    if (had && (prev as Record<string, unknown>)[key] === value) continue;
    next = { ...(next || prev), [key]: value };
  }
  return next || prev;
}
