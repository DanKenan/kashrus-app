import type { Connection } from './store.ts';
// Every list write passes this single guard. Report routes have no writer reference.
export function guardSourceWrite(c: Connection | undefined, list: string, fields: unknown): Record<string, string> {
    const reject = (status: number, error: string): never => { throw Object.assign(Error(error), { status }); };
    if (!c || c.sourceType === 'airtable' || c.sourceType === 'upload')
        return reject(409, 'Editing from the app is not available for this source.');
    if (c.access !== 'readwrite')
        return reject(403, 'This source is read only.');
    if (!['google_sheets', 'excel', 'supabase'].includes(c.sourceType) || !['companies', 'ingredients', 'products'].includes(list))
        return reject(400, 'Invalid list');
    const config = c.mapping[list as 'companies' | 'ingredients' | 'products'] as any;
    if (!config?.table || !fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length)
        return reject(400, 'Invalid fields');
    const output: Record<string, string> = Object.create(null);
    const allowed = list === 'companies' ? ['name', 'type', 'brand', 'plant', 'address', 'companyFee', 'mashgiachFee'] : list === 'ingredients' ? ['name', 'companyLink', 'brand', 'certification', 'agency', 'status', 'plant', 'expiresOn'] : ['name', 'companyLink', 'brand', 'code', 'certification', 'agency', 'status', 'symbolRequired', 'plant'];
    for (const [key, value] of Object.entries(fields)) {
        if (!allowed.includes(key) || typeof config[key] !== 'string' || !config[key] || typeof value !== 'string' || value.length > 2000)
            return reject(400, 'Only mapped list columns can be edited.');
        output[config[key]] = value;
    }
    return output;
}
