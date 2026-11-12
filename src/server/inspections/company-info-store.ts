import { randomBytes } from 'node:crypto';
import { createAgencyDocument, type DocumentDeps } from './food-service-store.ts';
import { bad, bounded, shape, validEmail } from './fees.ts';
export type Contact = { id: string; name: string; role: string; email: string; phone: string };
export type CompanyInfo = { address: string; phone: string; contacts: Contact[] };
export type CompanyInfoDoc = { places: Record<string, CompanyInfo>; updatedAt: string };
export const emptyInfo = (): CompanyInfo => ({ address: '', phone: '', contacts: [] });
export function validateCompanyInfo(v: any, old: CompanyInfo): CompanyInfo {
  shape(v, ['address', 'phone', 'contacts']);
  const address = bounded(v.address, 200), phone = bounded(v.phone, 40);
  if (!Array.isArray(v.contacts) || v.contacts.length > 20) bad('Too many contacts');
  const seen = new Set<string>();
  const contacts = v.contacts.map((c: any) => {
    shape(c, ['id', 'name', 'role', 'email', 'phone'], ['name', 'role', 'email', 'phone']);
    const id = c.id === undefined ? 'c_' + randomBytes(5).toString('hex') : c.id;
    if (!/^c_[a-z0-9]{10}$/.test(id) || seen.has(id) || c.id !== undefined && !old.contacts.some(o => o.id === id)) bad('Invalid contact id'); seen.add(id);
    const email = bounded(c.email, 200); if (email && !validEmail(email)) bad('Invalid email');
    return { id, name: bounded(c.name, 80, true), role: bounded(c.role, 40, true), email, phone: bounded(c.phone, 40) };
  });
  return { address, phone, contacts };
}
export const createCompanyInfoStore = (deps: DocumentDeps) => createAgencyDocument<CompanyInfoDoc>(deps, 'inspectionCompanyInfo', () => ({ places: {}, updatedAt: '' }));
