export function parseMoney(value: unknown): number | undefined {
  const s = String(value ?? '').trim();
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s)) return undefined;
  const amount = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(amount) && amount <= 100000 ? amount : undefined;
}
