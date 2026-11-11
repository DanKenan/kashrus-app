import assert from 'node:assert/strict';
import { parseDpm, splitCertification } from '../../src/lib/sourcePreview.ts';
import { parseDpm as serverDpm, splitCertification as serverSplit } from '../../src/server/sources/mapping.ts';
const values = ['OU-D', 'OU-P', 'OK-M', 'Star-K', 'cRc Dairy', 'OU DE', 'Group 1', 'group1', '', ' ', 'OU', 'Dairy', 'pareve', 'parve', 'meat', 'glatt', 'M', 'D', 'P', 'OU - Dairy', 'OK parve', 'STAR-K Meat', 'unknown', 'Group 2', 'ou-d'];
for (const value of values) {
  assert.deepEqual(parseDpm(value), serverDpm(value), value);
  for (const list of [undefined, [], ['Group 1', 'Group 2']]) assert.deepEqual(splitCertification(value, list), serverSplit(value, list), value);
}
console.log('source preview parity: OK');
