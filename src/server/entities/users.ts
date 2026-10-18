/**
 * Stage 3 Part 2 — User entity module.
 *
 * Per-entity Firestore collection: `users/{userId}`
 * Not wired into API routes yet (PR B). PR C will wire the write path.
 *
 * Note: passwords are NEVER stored in per-entity user docs in plaintext.
 * The existing auth system (bcrypt hashes in the monolith) is unchanged
 * in PR B. PR C will handle the migration carefully.
 */

export interface UserDoc {
  id: string;
  agencyId: string;
  email: string;
  name: string;
  role: 'admin' | 'coordinator' | 'mashgiach' | 'owner' | 'worker';
  venueId?: string;
  avatarColor?: string;
  createdAt: string;
  updatedAt: string;
  _v: number;
  // passwordHash is stored separately, never in this doc's readable fields
}

export async function createUser(
  db: any,
  params: {
    agencyId: string;
    email: string;
    name: string;
    role: UserDoc['role'];
    venueId?: string;
    avatarColor?: string;
  }
): Promise<UserDoc> {
  const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const doc: UserDoc = {
    id,
    agencyId: params.agencyId,
    email: params.email.toLowerCase(),
    name: params.name,
    role: params.role,
    venueId: params.venueId,
    avatarColor: params.avatarColor || '#3b82f6',
    createdAt: now,
    updatedAt: now,
    _v: 1,
  };
  await db.collection('users').doc(id).set(doc);
  return doc;
}

export async function getUser(db: any, userId: string): Promise<UserDoc | null> {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return null;
  return snap.data() as UserDoc;
}

export async function getUserByEmail(
  db: any,
  email: string
): Promise<UserDoc | null> {
  const snap = await db.collection('users')
    .where('email', '==', email.toLowerCase())
    .limit(1)
    .get();
  if (snap.docs.length === 0) return null;
  return snap.docs[0].data() as UserDoc;
}

export async function updateUser(
  db: any,
  userId: string,
  updates: Partial<Omit<UserDoc, 'id' | 'agencyId' | 'email' | 'createdAt' | '_v'>>,
  expectedVersion: number
): Promise<UserDoc> {
  const docRef = db.collection('users').doc(userId);
  const result = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error('User not found');
    const current = snap.data() as UserDoc;
    if (current._v !== expectedVersion) {
      throw new Error(`Version mismatch: expected ${expectedVersion}, got ${current._v}`);
    }
    const updated: UserDoc = {
      ...current,
      ...updates,
      id: current.id,
      agencyId: current.agencyId,
      email: current.email, // Email is immutable (identity)
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      _v: current._v + 1,
    };
    tx.update(docRef, updated);
    return updated;
  });
  return result;
}

export async function listUsersByAgency(
  db: any,
  agencyId: string,
  limit: number = 100
): Promise<UserDoc[]> {
  const snap = await db.collection('users')
    .where('agencyId', '==', agencyId)
    .orderBy('name')
    .limit(limit)
    .get();
  return snap.docs.map((d: any) => d.data() as UserDoc);
}
