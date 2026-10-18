/**
 * Stage 3 Part 2 — Task entity module.
 *
 * Per-entity Firestore collection: `tasks/{taskId}`
 * Not wired into API routes yet (PR B). PR C will wire the write path.
 *
 * IMPORTANT: TaskDoc preserves the EXACT shape of the existing TaskItem
 * from the monolith. Do not simplify or rename fields — the migration
 * must not lose information.
 *
 * All functions take `db` (the named Firestore instance) as first parameter.
 * Agency scoping is enforced by callers via the verified session user.
 */

export interface TaskCheckInItem {
  id: string;
  byName: string | null;
  byEmail: string | null;
  at: string; // ISO timestamp
  photoData?: string; // base64 data URL (optional photo evidence)
  photoCaption?: string;
}

export interface TaskDoc {
  id: string;
  agencyId?: string;
  venueId: string;
  title: string;
  description: string;
  category: string;
  categories?: string[];
  inputType: 'toggle' | 'yes_no' | 'status_select' | 'checkbox' | 'check_in';
  customStatusOptions?: string[];
  completedStatusValues?: string[];
  assignedTo: string[]; // ['all'] or array of worker emails
  scheduleType?: 'recurring' | 'specific_dates';
  daysOfWeek: number[];
  specificDates?: string[];
  targetTime?: string;
  targetTimeMinutes?: number;
  targetTime2?: string;
  targetTime2Minutes?: number;
  priority?: 'low' | 'medium' | 'high';
  enableOverdueAlert?: boolean;
  currentStatus: string;
  isCompleted: boolean;
  notes: string;
  updatedByEmail: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  createdAt: string;
  checkIns?: TaskCheckInItem[];
  sortOrder?: number;
  isPrivate?: boolean;
  _v: number; // Per-entity version, incremented transactionally
}

/**
 * Create a task document. Preserves the client-supplied ID if provided
 * (for idempotency — the client's retry contract depends on stable IDs).
 * If no ID is provided, generates one.
 */
export async function createTask(
  db: any,
  params: Omit<TaskDoc, '_v' | 'updatedAt'> & {
    id?: string; // Optional: use client-supplied ID for idempotency
    createdAt?: string; // Optional: preserve original creation date during migration
  }
): Promise<TaskDoc> {
  const id = params.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const doc: TaskDoc = {
    ...params,
    id,
    createdAt: params.createdAt || now,
    updatedAt: now,
    _v: 1,
  };
  // Use set with the specific ID (not add) to preserve client-supplied IDs
  await db.collection('tasks').doc(id).set(doc);
  return doc;
}

/**
 * Get a task by ID. Returns null if not found.
 */
export async function getTask(db: any, taskId: string): Promise<TaskDoc | null> {
  const snap = await db.collection('tasks').doc(taskId).get();
  if (!snap.exists) return null;
  return snap.data() as TaskDoc;
}

/**
 * Update a task transactionally. Increments _v.
 * Only updates if the current _v matches expectedVersion (optimistic locking).
 * Preserves immutable fields (id, agencyId, createdAt).
 */
export async function updateTask(
  db: any,
  taskId: string,
  updates: Partial<Omit<TaskDoc, 'id' | 'agencyId' | 'createdAt' | '_v'>>,
  expectedVersion: number
): Promise<TaskDoc> {
  const docRef = db.collection('tasks').doc(taskId);
  const result = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error('Task not found');
    }
    const current = snap.data() as TaskDoc;
    if (current._v !== expectedVersion) {
      throw new Error(`Version mismatch: expected ${expectedVersion}, got ${current._v}`);
    }
    const updated: TaskDoc = {
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

/**
 * Delete a task document.
 */
export async function deleteTask(db: any, taskId: string): Promise<void> {
  await db.collection('tasks').doc(taskId).delete();
}

/**
 * List tasks for a venue, ordered by creation.
 */
export async function listTasksByVenue(
  db: any,
  venueId: string,
  limit: number = 50
): Promise<TaskDoc[]> {
  const snap = await db.collection('tasks')
    .where('venueId', '==', venueId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d: any) => d.data() as TaskDoc);
}
