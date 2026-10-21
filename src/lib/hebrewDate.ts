import { addDays, DEFAULT_TIME_ZONE, isValidTimeZone, workDateIn } from './workday';
import { hebrewNumeral } from './kioskClock';

export const ZONE_SUNSET_POINTS: Record<string, [number, number]> = {
  'America/New_York': [40.71427, -74.00597],
  'Asia/Jerusalem': [31.76904, 35.21633],
  'America/Los_Angeles': [34.05223, -118.24368],
  'Pacific/Honolulu': [21.30694, -157.85833],
  'Australia/Sydney': [-33.86785, 151.20732],
  'America/Anchorage': [61.21806, -149.90028],
  'Europe/London': [51.50853, -0.12574],
  'America/Toronto': [43.70643, -79.39864],
  'America/Chicago': [41.85003, -87.65005],
  'America/Denver': [39.73915, -104.9847],
  'America/Phoenix': [33.44838, -112.07404],
  'America/Mexico_City': [19.42847, -99.12766],
  'America/Argentina/Buenos_Aires': [-34.61315, -58.37723],
  'Europe/Paris': [48.85341, 2.3488],
  'Africa/Johannesburg': [-26.20227, 28.04363],
};

function validPoint(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180;
}

const RAD = Math.PI / 180;
const MINUTE = 60000;

/** NOAA/Meeus apparent sunset minutes from UTC midnight, without day wrapping. */
function sunsetMinutes(at: number, lat: number, lng: number): number | null {
  const t = (at / 86400000 + 2440587.5 - 2451545) / 36525;
  const l0 = ((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360 + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const apparent = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparent * RAD));
  const y = Math.tan(obliquity * RAD / 2) ** 2;
  const eqTime = 4 / RAD * (y * Math.sin(2 * l0 * RAD) - 2 * e * Math.sin(m * RAD)
    + 4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD)
    - 0.5 * y * y * Math.sin(4 * l0 * RAD) - 1.25 * e * e * Math.sin(2 * m * RAD));
  const cosH = (Math.cos(90.833 * RAD) - Math.sin(lat * RAD) * Math.sin(declination))
    / (Math.cos(lat * RAD) * Math.cos(declination));
  if (!Number.isFinite(cosH) || Math.abs(cosH) > 1) return null;
  return 720 - 4 * lng - eqTime + 4 * Math.acos(cosH) / RAD;
}

/** Find a sunset belonging to the requested local date, including date-line zones. */
export function sunsetUtcMs(ymd: string, lat: number, lng: number, tz = 'UTC'): number | null {
  if (!validPoint(lat, lng) || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  try {
    for (const day of [ymd, addDays(ymd, -1), addDays(ymd, 1)]) {
      const midnight = Date.parse(`${day}T00:00:00Z`);
      const first = sunsetMinutes(midnight + 720 * MINUTE, lat, lng);
      if (first === null) continue;
      const refined = sunsetMinutes(midnight + first * MINUTE, lat, lng);
      if (refined === null) continue;
      const sunset = midnight + refined * MINUTE;
      if (Number.isFinite(sunset) && workDateIn(tz, sunset) === ymd) return sunset;
    }
  } catch { /* Invalid dates cannot produce a sunset. */ }
  return null;
}

interface HebrewDate {
  day: number;
  month: string;
  year: number;
  text: string;
  textShort: string;
  afterSunset: boolean;
  basis: 'coords' | 'zone-city' | 'midnight';
}

/** Display date only: sunset is approximate, with a midnight fallback. */
export function hebrewDateFor(instant: Date | number, tz: string, lat?: number, lng?: number): HebrewDate {
  const fallback: HebrewDate = { day: 0, month: '', year: 0, text: '', textShort: '', afterSunset: false, basis: 'midnight' };
  try {
    const at = typeof instant === 'number' ? instant : instant.getTime();
    if (!Number.isFinite(at)) return fallback;
    const zone = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
    const date = workDateIn(zone, at);
    const coords = validPoint(lat, lng);
    const point = coords ? [lat!, lng!] : Object.prototype.hasOwnProperty.call(ZONE_SUNSET_POINTS, zone) ? ZONE_SUNSET_POINTS[zone] : undefined;
    let basis: HebrewDate['basis'] = point ? (coords ? 'coords' : 'zone-city') : 'midnight';
    const sunset = point ? sunsetUtcMs(date, point[0], point[1], zone) : null;
    if (sunset === null) basis = 'midnight';
    const afterSunset = sunset !== null && at >= sunset;
    const civil = afterSunset ? addDays(date, 1) : date;
    const [y, m, d] = civil.split('-').map(Number);
    const formatter = new Intl.DateTimeFormat('he-u-ca-hebrew', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
    if (formatter.resolvedOptions().calendar !== 'hebrew') return fallback;
    const parts = formatter.formatToParts(new Date(Date.UTC(y, m - 1, d, 12)));
    const day = Number(parts.find(p => p.type === 'day')?.value);
    const month = parts.find(p => p.type === 'month')?.value || '';
    const year = Number(parts.find(p => p.type === 'year')?.value);
    if (!Number.isFinite(day) || !Number.isFinite(year) || !month) return fallback;
    const textShort = `${hebrewNumeral(day)} ב${month}`;
    return { day, month, year, textShort, text: `${textShort} ${hebrewNumeral(year)}`, afterSunset, basis };
  } catch {
    return fallback;
  }
}
