import assert from 'node:assert/strict';
import { failedItem, requiredAnswered, newFoodDraft, reconcileTemplate, foodPayload, reportQuery } from '../../src/lib/foodService.ts';
import { emptyChecklist, FoodChoice } from '../../src/components/ChecklistTemplatesScreen.tsx';
const item = { id: 'i_0000000000', label: ' Test check ', type: 'yes_no', required: true, help: '', problemIf: 'no', min: null, max: null };
// Binding server-rule truth table: unanswered and text never fail; numeric boundaries are inclusive.
for (const [patch, value, expected] of [
  [{}, null, false], [{}, false, true], [{}, true, false], [{ problemIf: 'yes' }, true, true], [{ problemIf: 'yes' }, false, false],
  [{ type: 'number', min: 0, max: 10 }, -1, true], [{ type: 'number', min: 0, max: 10 }, 0, false], [{ type: 'number', min: 0, max: 10 }, 10, false], [{ type: 'number', min: 0, max: 10 }, 11, true],
  [{ type: 'number', min: null, max: null }, -100, false], [{ type: 'text' }, 'no', false], [{ type: 'text' }, '', false],
]) assert.equal(failedItem({ ...item, ...patch }, value), expected);
assert.deepEqual(emptyChecklist(), { name: '', items: [] });
const template = { id: 't_000000000000', name: ' Test template ', items: [item], version: 1, updatedAt: '2026-11-11T00:00:00Z' };
const draft = newFoodDraft('fs_test', template, 'test-report-0000', '2026-11-11T00:00:00Z');
assert.equal(requiredAnswered(template, []), false);
assert.equal(requiredAnswered(template, [{ itemId: item.id, value: false }]), true);
assert.equal(requiredAnswered({ ...template, items: [{ ...item, type: 'number' }] }, [{ itemId: item.id, value: 0 }]), true);
assert.equal(requiredAnswered(null, []), true);
const answered = { ...draft, answers: [{ itemId: item.id, value: false, note: ' Test note ' }, { itemId: 'removed', value: true }], note: ' General ' };
const next = reconcileTemplate(answered, { ...template, version: 2 });
assert.equal(next.templateVersion, 2); assert.deepEqual(next.answers, [answered.answers[0]]);
assert.deepEqual(foodPayload(next), { kind: 'food_service', clientReportId: 'test-report-0000', companyId: 'fs_test', startedAt: '2026-11-11T00:00:00Z', templateId: template.id, templateVersion: 2, answers: [answered.answers[0]], note: ' General ' });
assert.throws(() => foodPayload({ ...draft, answers: [{ itemId: item.id, value: true, note: 'x'.repeat(501) }] }));
const filters = { type: 'food_service', status: 'follow_up', companyId: 'test/a', mashgiachId: 'test m', from: '2026-11-01', to: '2026-11-11' };
assert.equal(reportQuery(filters), 'limit=50&type=food_service&status=follow_up&companyId=test%2Fa&mashgiachId=test+m&from=2026-11-01&to=2026-11-11');
assert.equal(reportQuery(filters, 'older', true), reportQuery(filters) + '&before=older&more=1');
for (const selected of [true, false]) { const element = FoodChoice({ selected, children: 'Yes', onClick() {} }); assert.equal(element.props['aria-pressed'], selected); if (selected) { assert.match(element.props.className, /bg-ink/); assert.doesNotMatch(element.props.className, /bg-surface/); } }
console.log('food service rule table, empty draft, payload, reconciliation, filters and filled choices: OK');
