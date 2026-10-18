/**
 * Stage 3 Part 2 — Task entity module.
 *
 * Per-entity Firestore collection: `tasks/{taskId}`
 * Not wired into API routes yet (PR B). PR C will wire the write path.
 *
 * All functions take `db` (the named Firestore instance) as first parameter.
 * Agency scoping is enforced by callers via the verified session user.
 */

export interface TaskDoc {
  id: string;
  agencyId: string;
  venueId: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  priority?: number;
  assignedTo?: string;      // User ID
  createdBy: string;        // User ID
  createdAt: string;        // ISO
  updatedAt: string;        // ISO
  completedAt?: string;     // ISO
  dueDate?: string;         // ISO date
  _v: number;               // Per-entity version, incremented transactionally
}

/**
 * Create a task document. Returns the created doc.
 * The ID is server-generated (opaque).
 */
export async function createTask(
  db: any,
  params: {
    agencyId: string;
    venueId: string;
    title: string;
    description?: string;
    priority?: number;
    assignedTo?: string;
    createdBy: string;
    dueDate?: string;
  }
): Promise<TaskDoc> {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const doc: TaskDoc = {
    id,
    agencyId: params.agencyId,
    venueId: params.venueId,
    title: params.title,
    description: params.description,
    status: 'open',
    priority: params.priority,
    assignedTo: params.assignedTo,
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
    dueDate: params.dueDate,
    _v: 1,
  };
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
      id: current.id, // Never change ID
      agencyId: current.agencyId, // Never change agency
      createdAt: current.createdAt, // Never change creation time
      updatedAt: new Date().toISOString(),
      _v: current._v + 1,
    };
    tx.update(docRef, updated);
    return updated;
  });
  return result;
}

/**
 * Delete a task. (Soft delete via status change is preferred; this is hard delete.)
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

/**
 * List tasks assigned to a user.
 */
export async function listTasksByAssignee(
  db: any,
  userId: string,
  limit: number = 50
): Promise<TaskDoc[]> {
  const snap = await db.collection('tasks')
    .where('assignedTo', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d: any) => d.data() as TaskDoc);
}
