import assert from 'node:assert/strict';
import test from 'node:test';
import { selectChangedTaskIds } from './changed-task-ids.mjs';

const baseTask = {
  id: 'M1.01',
  detailFile: 'docs/roadmap/01-governance.md',
  evidence: 'docs/roadmap/evidence/M1.01.md',
};
const secondTask = { ...baseTask, id: 'M1.02', evidence: 'docs/roadmap/evidence/M1.02.md' };

function fixture(overrides = {}) {
  return selectChangedTaskIds({
    beforeRoadmap: '- [ ] M1.01 First task\n- [ ] M1.02 Second task\n',
    afterRoadmap: '- [ ] M1.01 First task\n- [ ] M1.02 Second task\n',
    beforeIndex: { tasks: [baseTask, secondTask] },
    afterIndex: { tasks: [baseTask, secondTask] },
    beforeDocuments: new Map([
      [baseTask.detailFile, '## M1.01 — First task\n\nBefore.\n\n## M1.02 — Second task\n\nSame.'],
      [baseTask.evidence, 'Evidence first.'],
      [secondTask.evidence, 'Evidence second.'],
    ]),
    afterDocuments: new Map([
      [baseTask.detailFile, '## M1.01 — First task\n\nBefore.\n\n## M1.02 — Second task\n\nSame.'],
      [baseTask.evidence, 'Evidence first.'],
      [secondTask.evidence, 'Evidence second.'],
    ]),
    ...overrides,
  });
}

test('selects only task whose master roadmap line changed', () => {
  assert.deepEqual(fixture({ afterRoadmap: '- [x] M1.01 First task\n- [ ] M1.02 Second task\n' }), [
    'M1.01',
  ]);
});

test('selects only task whose detail section changed in a shared card', () => {
  const afterDocuments = new Map([
    [baseTask.detailFile, '## M1.01 — First task\n\nBefore.\n\n## M1.02 — Second task\n\nChanged.'],
    [baseTask.evidence, 'Evidence first.'],
    [secondTask.evidence, 'Evidence second.'],
  ]);
  assert.deepEqual(fixture({ afterDocuments }), ['M1.02']);
});

test('selects only task whose evidence changed', () => {
  const afterDocuments = new Map([
    [baseTask.detailFile, '## M1.01 — First task\n\nBefore.\n\n## M1.02 — Second task\n\nSame.'],
    [baseTask.evidence, 'Evidence first.'],
    [secondTask.evidence, 'Updated evidence second.'],
  ]);
  assert.deepEqual(fixture({ afterDocuments }), ['M1.02']);
});

test('selects task index edits and fails closed when a task is removed', () => {
  assert.deepEqual(
    fixture({ afterIndex: { tasks: [{ ...baseTask, title: 'Revised' }, secondTask] } }),
    ['M1.01']
  );
  assert.throws(() => fixture({ afterIndex: { tasks: [secondTask] } }), /removed/u);
});

test('returns no tasks for unrelated changes', () => {
  assert.deepEqual(fixture(), []);
});

test('selects changed K-series checkbox and card sections without changing M selection', () => {
  const task = {
    id: 'K0-001',
    detailFile: 'docs/roadmap/12-local-ai-rebuild.md',
    evidence: 'docs/roadmap/evidence/K0-001.md',
  };
  const result = selectChangedTaskIds({
    beforeRoadmap: '- [ ] K0-001 Baseline\n',
    afterRoadmap: '- [x] K0-001 Baseline\n',
    beforeIndex: { tasks: [task] },
    afterIndex: { tasks: [task] },
    beforeDocuments: new Map([[task.detailFile, '## K0-001 — Baseline\n\nOld.']]),
    afterDocuments: new Map([[task.detailFile, '## K0-001 — Baseline\n\nNew.']]),
  });
  assert.deepEqual(result, ['K0-001']);
});
