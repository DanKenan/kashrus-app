import { feesRequest } from './fees';
export interface Contact { id?: string; name: string; role: string; email: string; phone: string }
export interface CompanyInfo { address: string; phone: string; contacts: Contact[] }
export type PlaceInfo = Pick<CompanyInfo, 'address' | 'phone'>;
export const emptyCompanyInfo = (): CompanyInfo => ({ address: '', phone: '', contacts: [] });
export const emptyContact = (): Contact => ({ name: '', role: '', email: '', phone: '' });
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(n => n[0]).join('').toUpperCase();
export const mapsUrl = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
export const getCompanyInfo = (id: string) => feesRequest<CompanyInfo>(`/api/inspections/company-info/${encodeURIComponent(id)}`);
export const saveCompanyInfo = (id: string, info: CompanyInfo) => feesRequest<CompanyInfo>(`/api/inspections/company-info/${encodeURIComponent(id)}`, 'PUT', info);
export async function getPlaceInfo(id: string): Promise<PlaceInfo> { const data = await feesRequest<PlaceInfo>(`/api/visits/places/${encodeURIComponent(id)}/info`); return { address: data.address, phone: data.phone }; }
