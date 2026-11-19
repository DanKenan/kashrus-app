import { createAgencyDocument, type DocumentDeps } from './food-service-store.ts';

export type SheetRemovalEvidence = {
  binding: string;
  rowCount: number;
  remainingRowsHash: string;
  metadataId?: number;
};

export type CompanyRemoval = {
  source: string;
  archived: boolean;
  name: string;
  recordKey?: string;
  archiveKey?: string;
  archivedCompanyId?: string;
  sheetEvidence?: SheetRemovalEvidence;
  companyFee?: number;
  mashgiachFee?: number;
  requested?: 'guided' | 'direct';
  deletedAt?: string;
  cleaned?: boolean;
};

export function createCompanyRemovalStore(deps: DocumentDeps) {
  return createAgencyDocument<{ companies: Record<string, CompanyRemoval>; updatedAt: string }>(
    deps, 'inspectionCompanyRemoval', () => ({ companies: {}, updatedAt: '' }),
  );
}

// Three calendar months in UTC, clamped to the last day of the target month.
export function retentionElapsed(deletedAt: string, now: Date) {
  const end = new Date(deletedAt);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 3);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return now.getTime() > end.getTime();
}
