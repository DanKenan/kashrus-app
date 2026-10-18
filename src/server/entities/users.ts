/**
 * Stage 3 Part 2 — User entity module.
 *
 * Per-entity Firestore collection: `users/{userId}`
 * Plus uniqueness lookup: `usersByEmail/{sha256(email)}` → { userId }
 *
 * Not wired into API routes yet (PR B). PR C will wire the write path.
 *
 * Preserves the EXACT shape of UserProfile, including auth fields:
 * - password: bcrypt hash (NEVER sent to clients, NEVER logged)
 * - kioskPin: 4-6 digit PIN (NEVER sent to clients)
 * - permissions: UserPermissions
 *
 * Email uniqueness is enforced transactionally via usersByEmail.
 */

import crypto from 'crypto';

export interface UserPermissions {
  canFillTasks?: boolean;
  canAssignTasks?: boolean;
  // ... other permissions as defined in server.ts
}

export interface UserDoc {
  id: string;
  agencyId?: string;
  email: string; // Always lowercase
  name: string;
  role: 'admin' | 'coordinator' | 'mashgiach' | 'owner' | 'worker';
  avatarColor: string;
  password?: string; // bcrypt hash — NEVER exposed via API
  kioskPin?: string; // NEVER exposed via API
  venueId?: string;
  permissions?: UserPermissions;
  createdAt: string;
  updatedAt: string;
  _v: number;
}

function emailKey(email: string): string {
  // SHA-256 of lowercase email, for the usersByEmail lookup
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export async function createUser(
  db: any,
  params: Omit<UserDoc, '_v' | 'createdAt' | 'updatedAt' | 'email' | 'id'> & {
    id?: string;
    email: string;
  }
): Promise<UserDoc> {
  const id = params.id || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = params.email.trim().toLowerCase();
  const now = new Date().toISOString();

  // Transactionally enforce email uniqueness via usersByEmail AND
  // ensure the user ID doesn't already exist (create-if-absent).
  const result = await db.runTransaction(async (tx: any) => {
    // Check ID doesn't exist
    const userRef = db.collection('users').doc(id);
    const existingUser = await tx.get(userRef);
    if (existingUser.exists) {
      throw new Error(`User already exists: ${id}. Use updateUser to modify it.`);
    }
    // Check email uniqueness
    const key = emailKey(email);
    const existingRef = db.collection('usersByEmail').doc(key);
    const existing = await tx.get(existingRef);
    if (existing.exists) {
      throw new Error(`Email already in use: ${email}`);
    }
    const doc: UserDoc = {
      ...params,
      id,
      email,
      createdAt: now,
      updatedAt: now,
      _v: 1,
    };
    tx.set(userRef, doc);
    tx.set(existingRef, { userId: id, email });
    return doc;
  });
  return result;
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
  const key = emailKey(email);
  const lookup = await db.collection('usersByEmail').doc(key).get();
  if (!lookup.exists) return null;
  const userId = lookup.data().userId;
  return getUser(db, userId);
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
      email: current.email, // Email immutable (use separate flow to change)
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

/**
 * Sanitize a UserDoc for API responses — strips password and kioskPin.
 * NEVER send auth secrets to clients.
 */
export function sanitizeUser(doc: UserDoc): Omit<UserDoc, 'password' | 'kioskPin'> {
  const { password, kioskPin, ...safe } = doc;
  return safe;
}
