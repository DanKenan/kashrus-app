/**
 * Part 2 PR B: Entity module unit tests.
 * Tests tasks, venues, users CRUD with mocked Firestore.
 * Verifies document shapes match the real monolith structures.
 */
import { createTask, getTask, updateTask, deleteTask, listTasksByVenue } from '../../src/server/entities/tasks.ts';
import { createVenue, getVenue, updateVenue, listVenuesByAgency } from '../../src/server/entities/venues.ts';
import { createUser, getUser, getUserByEmail, updateUser, listUsersByAgency, sanitizeUser } from '../../src/server/entities/users.ts';

function createMockDb() {
  const docs = new Map();
  return {
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          const ref = {
            async get() {
              const d = docs.get(key);
              return { exists: !!d, data: () => d, id, ref };
            },
            async set(data) { docs.set(key, data); },
            async update(u) {
              const d = docs.get(key);
              if (!d) throw new Error('Not found');
              docs.set(key, { ...d, ...u });
            },
            async delete() { docs.delete(key); },
          };
          return ref;
        },
        where(field, op, value) {
          const q = {
            _f: [{ field, op, value }],
            _order: null, _limit: null,
            where(f, o, v) { q._f.push({ field: f, op: o, value: v }); return q; },
            orderBy(f, dir) { q._order = { f, dir }; return q; },
            limit(n) { q._limit = n; return q; },
            async get() {
              let res = [];
              for (const [k, v] of docs) {
                if (!k.startsWith(name + '/')) continue;
                let ok = true;
                for (const f of q._f) {
                  if (f.op === '==' && v[f.field] !== f.value) ok = false;
                }
                if (ok) res.push({ id: k.split('/')[1], data: () => v });
              }
              if (q._order) res.sort((a, b) => {
                const av = a.data()[q._order.f], bv = b.data()[q._order.f];
                return q._order.dir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
              });
              if (q._limit) res = res.slice(0, q._limit);
              return { docs: res };
            },
          };
          return q;
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        get: async (ref) => ref.get(),
        update: (ref, u) => ref.update(u),
        set: (ref, data) => ref.set(data),
      };
      return fn(tx);
    },
    _docs: docs,
  };
}

export default {
  name: 'Part 2 PR B: Entity modules (correct shapes)',
  whatItProves: 'CRUD preserves real TaskItem/Venue/UserProfile shapes; auth fields kept; IDs stable.',

  async run() {
    const db = createMockDb();

    // Tasks — must match TaskItem shape
    const task = await createTask(db, {
      agencyId: 'agency-hkc',
      venueId: 'venue-1',
      title: 'Test task',
      description: 'Test description',
      category: 'cleaning',
      inputType: 'checkbox',
      assignedTo: ['worker@example.com'], // Array of emails, not single ID
      daysOfWeek: [1, 2, 3],
      priority: 'high', // Enum, not number
      currentStatus: 'pending',
      isCompleted: false, // Boolean, not status enum
      notes: '',
      updatedByEmail: null,
      updatedByName: null,
      updatedAt: null,
    });
    if (!task.id.startsWith('task-')) throw new Error('Bad task ID');
    if (task._v !== 1) throw new Error('Initial _v should be 1');
    if (!Array.isArray(task.assignedTo)) throw new Error('assignedTo must be array');
    if (typeof task.isCompleted !== 'boolean') throw new Error('isCompleted must be boolean');

    // Client-supplied ID preserved (idempotency)
    const task2 = await createTask(db, {
      id: 'client-generated-123',
      agencyId: 'agency-hkc',
      venueId: 'venue-1',
      title: 'Client ID task',
      description: '',
      category: 'other',
      inputType: 'toggle',
      assignedTo: ['all'],
      daysOfWeek: [],
      currentStatus: '',
      isCompleted: false,
      notes: '',
      updatedByEmail: null,
      updatedByName: null,
      updatedAt: null,
    });
    if (task2.id !== 'client-generated-123') throw new Error('Client ID not preserved');
    console.log('  ✓ tasks preserve TaskItem shape + client IDs');

    // Create-if-absent: reusing an ID must fail, not overwrite
    try {
      await createTask(db, {
        id: 'client-generated-123', // Same ID as above
        agencyId: 'agency-hkc',
        venueId: 'venue-1',
        title: 'Overwrite attempt',
        description: '',
        category: 'other',
        inputType: 'toggle',
        assignedTo: ['all'],
        daysOfWeek: [],
        currentStatus: '',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
      });
      throw new Error('Should reject duplicate ID');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
    }
    console.log('  ✓ tasks reject duplicate IDs (create-if-absent)');

    const updated = await updateTask(db, task.id, { isCompleted: true }, 1);
    if (updated._v !== 2 || updated.isCompleted !== true) throw new Error('Update failed');
    try {
      await updateTask(db, task.id, { isCompleted: false }, 1);
      throw new Error('Should fail on stale version');
    } catch (e) {
      if (!e.message.includes('Version mismatch')) throw e;
    }
    console.log('  ✓ tasks optimistic locking');

    // Venues — must match Venue shape
    const venue = await createVenue(db, {
      agencyId: 'agency-hkc',
      name: 'Crown Market',
      category: 'grocery',
      address: '123 Main St',
      certification: 'HKC',
      ownerEmail: 'owner@example.com',
    });
    if (venue.category !== 'grocery') throw new Error('Missing category');
    if (venue.certification !== 'HKC') throw new Error('Missing certification');
    console.log('  ✓ venues preserve Venue shape');

    // Users — must preserve auth fields
    const user = await createUser(db, {
      agencyId: 'agency-hkc',
      email: 'Test@Example.com',
      name: 'Test User',
      role: 'mashgiach',
      avatarColor: '#ff0000',
      password: '$2b$10$hashedpassword', // bcrypt hash preserved
      kioskPin: '1234', // PIN preserved
      permissions: { canFillTasks: true },
    });
    if (user.email !== 'test@example.com') throw new Error('Email not lowercased');
    if (user.password !== '$2b$10$hashedpassword') throw new Error('Password hash lost!');
    if (user.kioskPin !== '1234') throw new Error('Kiosk PIN lost!');

    // Email uniqueness enforced (with trim + case-insensitive)
    try {
      await createUser(db, {
        agencyId: 'agency-hkc',
        email: '  TEST@example.com  ', // Same email, different case + whitespace
        name: 'Duplicate',
        role: 'worker',
        avatarColor: '#000',
      });
      throw new Error('Should reject duplicate email');
    } catch (e) {
      if (!e.message.includes('already in use')) throw e;
    }
    console.log('  ✓ users preserve auth fields + email uniqueness (trim/case-insensitive)');

    // User ID collision rejected
    try {
      await createUser(db, {
        id: user.id, // Same ID as the first user
        agencyId: 'agency-hkc',
        email: 'different@example.com',
        name: 'ID Collision',
        role: 'worker',
        avatarColor: '#000',
      });
      throw new Error('Should reject duplicate user ID');
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
    }
    console.log('  ✓ users reject duplicate IDs (create-if-absent)');

    // Sanitize strips secrets
    const safe = sanitizeUser(user);
    if ('password' in safe || 'kioskPin' in safe) {
      throw new Error('sanitizeUser must strip secrets');
    }
    console.log('  ✓ sanitizeUser strips password/kioskPin');

    // getUserByEmail works via lookup
    const byEmail = await getUserByEmail(db, 'TEST@example.com'); // Different case
    if (!byEmail || byEmail.id !== user.id) throw new Error('getUserByEmail failed');
    console.log('  ✓ usersByEmail lookup (case-insensitive)');

    console.log('  ✓ All entity tests passed');
  },
};
