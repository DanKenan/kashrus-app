import { createAgencyDocument, type DocumentDeps } from './food-service-store.ts';
import type { FeesDoc } from './fees.ts';
export const createFeesStore = (deps: DocumentDeps) => createAgencyDocument<FeesDoc>(deps, 'inspectionFees', () => ({ settings: { feeEditors: 'admins' }, places: {}, accountant: null, lastSent: null, decisions: {}, updatedAt: '' }));
