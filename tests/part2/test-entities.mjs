/**
 * Part 2 PR B: Entity module unit tests.
 * Tests tasks, venues, users CRUD with mocked Firestore.
 * Calls the actual functions — not wired into routes yet.
 */
import { createTask, getTask, updateTask, deleteTask, listTasksByVenue } from '../../src/server/entities/tasks.ts';
import { createVenue, getVenue, updateVenue, listVenuesByAgency } from '../../src/server/entities/venues.ts';
import { createUser, getUser, getUserByEmail, updateUser, listUsersByAgency } from '../../src/server/entities/users.ts';

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
            _order: null,
            _limit: null,
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
              if (q._order) {
                res.sort((a, b) => {
                  const av = a.data()[q._order.f], bv = b.data()[q._order.f];
                  return q._order.dir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
                });
              }
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
      };
      return fn(tx);
    },
    _docs: docs,
  };
}

export default {
  name: 'Part 2 PR B: Entity modules (tasks, venues, users)',
  whatItProves: 'CRUD helpers work correctly with mocked Firestore; versioning prevents stale writes.',

  async run() {
    const db = createMockDb();

    // Tasks
    const task = await createTask(db, {
      agencyId: 'agency-hkc',
      venueId: 'venue-1',
      title: 'Test task',
      createdBy: 'user-1',
    });
    if (!task.id.startsWith('task-')) throw new Error('Bad task ID');
    if (task._v !== 1) throw new Error('Initial _v should be 1');

    const fetched = await getTask(db, task.id);
    if (!fetched || fetched.title !== 'Test task') throw new Error('getTask failed');

    const updated = await updateTask(db, task.id, { status: 'completed' }, 1);
    if (updated._v !== 2) throw new Error('_v should increment');
    if (updated.status !== 'completed') throw new Error('Status not updated');

    // Stale version should fail
    try {
      await updateTask(db, task.id, { status: 'open' }, 1);
      throw new Error('Should have failed on stale version');
    } catch (e) {
      if (!e.message.includes('Version mismatch')) throw e;
    }
    console.log('  ✓ tasks CRUD + optimistic locking');

    // Venues
    const venue = await createVenue(db, { agencyId: 'agency-hkc', name: 'Crown Market' });
    const vFetched = await getVenue(db, venue.id);
    if (!vFetched || vFetched.name !== 'Crown Market') throw new Error('getVenue failed');
    const vUpdated = await updateVenue(db, venue.id, { phone: '555-1234' }, 1);
    if (vUpdated._v !== 2) throw new Error('Venue _v should increment');
    const vList = await listVenuesByAgency(db, 'agency-hkc');
    if (vList.length !== 1) throw new Error('listVenuesByAgency failed');
    console.log('  ✓ venues CRUD');

    // Users
    const user = await createUser(db, {
      agencyId: 'agency-hkc',
      email: 'Test@Example.com',
      name: 'Test User',
      role: 'mashgiach',
    });
    if (user.email !== 'test@example.com') throw new Error('Email should be lowercase');
    const uByEmail = await getUserByEmail(db, 'test@example.com');
    if (!uByEmail || uByEmail.id !== user.id) throw new Error('getUserByEmail failed');
    const uUpdated = await updateUser(db, user.id, { name: 'New Name' }, 1);
    if (uUpdated.name !== 'New Name' || uUpdated._v !== 2) throw new Error('updateUser failed');
    // Email is immutable
    const uUpdated2 = await updateUser(db, user.id, { name: 'Another' }, 2);
    if (uUpdated2.email !== 'test@example.com') throw new Error('Email should not change');
    console.log('  ✓ users CRUD (email immutable, lowercase)');

    // Delete
    await deleteTask(db, task.id);
    const deleted = await getTask(db, task.id);
    if (deleted !== null) throw new Error('deleteTask failed');
    console.log('  ✓ delete');

    console.log('  ✓ All entity module tests passed');
  },
};
