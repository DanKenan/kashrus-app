import { feesRequest } from './fees';
import type { AirtableContact } from '../server/sources/types';
export interface Contact { id?: string; name: string; role: string; email: string; phone: string }
export interface CompanyInfo { address: string; phone: string; contacts: Contact[] }
export type AirtableContactDto = Readonly<Omit<AirtableContact, 'companyIds' | 'roles'>> & { readonly roles: readonly string[] };
export interface AirtableContactsResponse {
  contacts: AirtableContactDto[];
  configured: boolean;
  status: 'not_configured' | 'loading' | 'ok' | 'stale' | 'error';
  lastReadAt: string | null;
  timeZone?: string;
}
export type PlaceInfo = Pick<CompanyInfo, 'address' | 'phone'>;
export const emptyCompanyInfo = (): CompanyInfo => ({ address: '', phone: '', contacts: [] });
export const emptyContact = (): Contact => ({ name: '', role: '', email: '', phone: '' });
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(n => n[0]).join('').toUpperCase();
export const mapsUrl = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
export const getCompanyInfo = (id: string) => feesRequest<CompanyInfo>(`/api/inspections/company-info/${encodeURIComponent(id)}`);
export const getAirtableContacts = (id: string) => feesRequest<AirtableContactsResponse>(`/api/inspections/company-info/${encodeURIComponent(id)}/airtable-contacts`);
export const saveCompanyInfo = (id: string, info: Partial<CompanyInfo>) => feesRequest<CompanyInfo>(`/api/inspections/company-info/${encodeURIComponent(id)}`, 'PUT', info);
export async function getPlaceInfo(id: string): Promise<PlaceInfo> { const data = await feesRequest<PlaceInfo>(`/api/visits/places/${encodeURIComponent(id)}/info`); return { address: data.address, phone: data.phone }; }

export function groupCompanyContacts(app: readonly Contact[], airtable: readonly AirtableContactDto[]) {
  const emailOf = (contact: Contact | AirtableContactDto) => contact.email.trim().toLowerCase();
  function byEmail<T extends Contact | AirtableContactDto>(contacts: readonly T[]) {
    const emails = new Map<string, T[]>();
    for (const contact of contacts) {
      const email = emailOf(contact);
      if (!email) continue;
      const matches = emails.get(email);
      if (matches) matches.push(contact);
      else emails.set(email, [contact]);
    }
    return emails;
  }
  const appEmails = byEmail(app), airtableEmails = byEmail(airtable);
  const duplicates = (email: string) => (appEmails.get(email)?.length ?? 0) > 1 || (airtableEmails.get(email)?.length ?? 0) > 1;
  const matched = new Set<AirtableContactDto>();
  const cards: { app?: Contact; index?: number; airtable?: AirtableContactDto; duplicate: boolean }[] = app.map((contact, index) => {
    const email = emailOf(contact), other = airtableEmails.get(email);
    const match = appEmails.get(email)?.length === 1 && other?.length === 1 ? other[0] : undefined;
    if (match) matched.add(match);
    return { app: contact, index, airtable: match, duplicate: duplicates(email) };
  });
  for (const contact of airtable)
    if (!matched.has(contact)) cards.push({ airtable: contact, duplicate: duplicates(emailOf(contact)) });
  const name = (card: typeof cards[number]) => card.app?.name || card.airtable?.name || '';
  return cards.sort((a, b) => name(a).localeCompare(name(b)));
}
