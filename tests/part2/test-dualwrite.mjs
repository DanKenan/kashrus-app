/**
 * Part 2 PR C: Dual-write tests.
 *
 * Per amended Point #6: uses fixtures matching the EXISTING production schema
 * (real TaskItem, Venue, UserProfile shapes from server.ts), not invented fixtures.
 *
 * Verifies: changed entities are mirrored to per-entity collections in the
 * same transaction; unchanged entities are NOT rewritten; deletions propagate;
 * per-entity _v increments correctly; usersByEmail lookup is maintained.
 */
import { dualWriteChangedEntities } from '../../src/server/dualwrite.ts';
import crypto from 'crypto';

// Production-schema fixtures (match TaskItem, Venue, UserProfile in server.ts)
const realTask = {
  id: 'task-1792117476241',
  agencyId: 'agency-hkc',
  venueId: 'venue-1792117476241',
  title: 'Check milk delivery',
  description: 'Verify kosher certification on delivery',
  category: 'deliveries',
  categories: ['deliveries', 'dairy'],
  inputType: 'checkbox',
  assignedTo: ['mashgiach@example.com'], // Array of emails
  daysOfWeek: [1, 2, 3, 4, 5],
  priority: 'high', // Enum, not number
  currentStatus: 'pending',
  isCompleted: false, // Boolean, not status enum
  notes: '',
  updatedByEmail: null,
  updatedByName: null,
  updatedAt: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  sortOrder: 1,
};

const realVenue = {
  id: 'venue-1792117476241',
  agencyId: 'agency-hkc',
  name: 'Crown Market',
  category: 'grocery',
  address: '123 Main St, Hartford, CT',
  certification: 'HKC',
  ownerEmail: 'owner@crownmarket.com',
  createdAt: '2026-10-01T00:00:00.000Z',
};

const realUser = {
  id: 'user-kenan',
  agencyId: 'agency-hkc',
  email: 'kenan@hartfordkashrut.org',
  name: 'Don',
  role: 'admin',
  avatarColor: '#3b82f6',
  password: '$2b$10$fakehashforauth', // bcrypt hash must be preserved
  kioskPin: '1234', // PIN must be preserved
  permissions: { canFillTasks: true, canAssignTasks: true },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function createMockTx() {
  const writes = []; // {op, collection, id, data}
  const existingDocs = new Map(); // "collection/id" -> data (for _v lookup)
  return {
    writes,
    existingDocs,
    async get(ref) {
      const key = `${ref._collection}/${ref._id}`;
      const d = existingDocs.get(key);
      return { exists: !!d, data: () => d };
    },
    set(ref, data) {
      writes.push({ op: 'set', collection: ref._collection, id: ref._id, data });
    },
    delete(ref) {
      writes.push({ op: 'delete', collection: ref._collection, id: ref._id });
    },
  };
}

function createMockDb() {
  return {
    collection(name) {
      return {
        doc(id) { return { _collection: name, _id: id }; },
      };
    },
  };
}

export default {
  name: 'Part 2 PR C: Dual-write (production fixtures)',
  whatItProves: 'Changed entities mirror to per-entity collections; _v increments; usersByEmail maintained.',

  async run() {
    const db = createMockDb();

    // Test 1: New task is written with _v=1
    {
      const tx = createMockTx();
      const before = { tasks: [], venues: [], users: [] };
      const after = { tasks: [realTask], venues: [], users: [] };
      await dualWriteChangedEntities(tx, db, before, after);

      const taskWrite = tx.writes.find(w => w.collection === 'tasks' && w.id === realTask.id);
      if (!taskWrite) throw new Error('New task was not dual-written');
      if (taskWrite.data._v !== 1) throw new Error(`Expected _v=1, got ${taskWrite.data._v}`);
      // Verify all TaskItem fields preserved (not dropped)
      if (taskWrite.data.isCompleted !== false) throw new Error('isCompleted lost');
      if (!Array.isArray(taskWrite.data.assignedTo)) throw new Error('assignedTo lost');
      if (taskWrite.data.priority !== 'high') throw new Error('priority lost');
      if (taskWrite.data.currentStatus !== 'pending') throw new Error('currentStatus lost');
      console.log('  ✓ new task dual-written with _v=1, all fields preserved');
    }

    // Test 2: Updated task increments _v, unchanged task NOT rewritten
    {
      const tx = createMockTx();
      // Simulate existing per-entity doc with _v=3
      tx.existingDocs.set(`tasks/${realTask.id}`, { ...realTask, _v: 3 });

      const unchangedTask = { ...realTask, id: 'task-unchanged' };
      const before = { tasks: [realTask, unchangedTask], venues: [], users: [] };
      const updatedTask = { ...realTask, isCompleted: true, notes: 'Done!' };
      const after = { tasks: [updatedTask, unchangedTask], venues: [], users: [] };
      await dualWriteChangedEntities(tx, db, before, after);

      const writes = tx.writes.filter(w => w.collection === 'tasks');
      if (writes.length !== 1) throw new Error(`Expected 1 task write, got ${writes.length} (unchanged task should not be rewritten)`);
      if (writes[0].data._v !== 4) throw new Error(`Expected _v=4, got ${writes[0].data._v}`);
      if (writes[0].data.isCompleted !== true) throw new Error('Update not applied');
      console.log('  ✓ updated task _v increments (3→4); unchanged task not rewritten');
    }

    // Test 3: Deleted task is removed from per-entity collection
    {
      const tx = createMockTx();
      const before = { tasks: [realTask], venues: [], users: [] };
      const after = { tasks: [], venues: [], users: [] };
      await dualWriteChangedEntities(tx, db, before, after);

      const del = tx.writes.find(w => w.op === 'delete' && w.collection === 'tasks' && w.id === realTask.id);
      if (!del) throw new Error('Deleted task was not removed from per-entity collection');
      console.log('  ✓ deleted task removed from per-entity collection');
    }

    // Test 4: User dual-write preserves auth fields + maintains usersByEmail
    {
      const tx = createMockTx();
      const before = { tasks: [], venues: [], users: [] };
      const after = { tasks: [], venues: [], users: [realUser] };
      await dualWriteChangedEntities(tx, db, before, after);

      const userWrite = tx.writes.find(w => w.collection === 'users' && w.id === realUser.id);
      if (!userWrite) throw new Error('New user was not dual-written');
      if (userWrite.data.password !== realUser.password) throw new Error('Password hash LOST in dual-write!');
      if (userWrite.data.kioskPin !== realUser.kioskPin) throw new Error('Kiosk PIN LOST in dual-write!');
      if (!userWrite.data.permissions) throw new Error('Permissions LOST in dual-write!');

      // usersByEmail lookup created
      const expectedKey = crypto.createHash('sha256').update(realUser.email.toLowerCase()).digest('hex');
      const lookupWrite = tx.writes.find(w => w.collection === 'usersByEmail' && w.id === expectedKey);
      if (!lookupWrite) throw new Error('usersByEmail lookup not created');
      if (lookupWrite.data.userId !== realUser.id) throw new Error('usersByEmail points to wrong user');
      console.log('  ✓ user auth fields preserved; usersByEmail lookup created');
    }

    // Test 5: Venue dual-write preserves all fields
    {
      const tx = createMockTx();
      const before = { tasks: [], venues: [], users: [] };
      const after = { tasks: [], venues: [realVenue], users: [] };
      await dualWriteChangedEntities(tx, db, before, after);

      const venueWrite = tx.writes.find(w => w.collection === 'venues' && w.id === realVenue.id);
      if (!venueWrite) throw new Error('New venue was not dual-written');
      if (venueWrite.data.category !== 'grocery') throw new Error('Venue category lost');
      if (venueWrite.data.certification !== 'HKC') throw new Error('Venue certification lost');
      if (venueWrite.data.ownerEmail !== 'owner@crownmarket.com') throw new Error('Venue ownerEmail lost');
      console.log('  ✓ venue dual-written with all fields preserved');
    }

    // Test 6: No changes = no writes (idempotent on no-op)
    {
      const tx = createMockTx();
      const doc = { tasks: [realTask], venues: [realVenue], users: [realUser] };
      await dualWriteChangedEntities(tx, db, doc, JSON.parse(JSON.stringify(doc)));
      if (tx.writes.length !== 0) throw new Error(`Expected 0 writes for no-op, got ${tx.writes.length}`);
      console.log('  ✓ no-op produces zero writes');
    }

    console.log('  ✓ All dual-write tests passed');
  },
};
