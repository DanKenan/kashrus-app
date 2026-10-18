/**
 * Stage 3 Part 2 — Venue entity module.
 *
 * Per-entity Firestore collection: `venues/{venueId}`
 * Not wired into API routes yet (PR B). PR C will wire the write path.
 *
 * Preserves the EXACT shape of the existing Venue from the monolith.
 */

export interface VenueDoc {
  id: string;
  agencyId: string;
  name: string;
  category: string;
  address: string;
  certification: string;
  ownerEmail?: string;
  createdAt: string;
  updatedAt?: string;
  _v: number;
}

export async function createVenue(
  db: any,
  params: Omit<VenueDoc, '_v' | 'updatedAt'> & {
    id?: string;
    createdAt?: string; // Optional: preserve original creation date during migration
  }
): Promise<VenueDoc> {
  const id = params.id || `venue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const doc: VenueDoc = {
    ...params,
    id,
    createdAt: params.createdAt || now,
    updatedAt: now,
    _v: 1,
  };
  await db.collection('venues').doc(id).set(doc);
  return doc;
}

export async function getVenue(db: any, venueId: string): Promise<VenueDoc | null> {
  const snap = await db.collection('venues').doc(venueId).get();
  if (!snap.exists) return null;
  return snap.data() as VenueDoc;
}

export async function updateVenue(
  db: any,
  venueId: string,
  updates: Partial<Omit<VenueDoc, 'id' | 'agencyId' | 'createdAt' | '_v'>>,
  expectedVersion: number
): Promise<VenueDoc> {
  const docRef = db.collection('venues').doc(venueId);
  const result = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error('Venue not found');
    const current = snap.data() as VenueDoc;
    if (current._v !== expectedVersion) {
      throw new Error(`Version mismatch: expected ${expectedVersion}, got ${current._v}`);
    }
    const updated: VenueDoc = {
      ...current,
      ...updates,
      id: current.id,
      agencyId: current.agencyId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      _v: current._v + 1,
    };
    tx.update(docRef, updated);
    return updated;
  });
  return result;
}

export async function listVenuesByAgency(
  db: any,
  agencyId: string,
  limit: number = 100
): Promise<VenueDoc[]> {
  const snap = await db.collection('venues')
    .where('agencyId', '==', agencyId)
    .orderBy('name')
    .limit(limit)
    .get();
  return snap.docs.map((d: any) => d.data() as VenueDoc);
}
