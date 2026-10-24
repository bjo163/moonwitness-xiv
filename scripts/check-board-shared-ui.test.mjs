import assert from 'node:assert/strict';
import test from 'node:test';
import { findBoardUiViolations } from './check-board-shared-ui.mjs';

test('raw Board form controls fail with a location, replacement, and rerun command', () => {
  const violations = findBoardUiViolations(
    'export function Form() {\n  return <><button /><input /><select /><textarea /></>;\n}',
    'apps/board/src/form.tsx'
  );

  assert.equal(violations.length, 4);
  assert.match(violations[0], /apps\/board\/src\/form\.tsx:2: raw JSX <button>/u);
  assert.match(violations[0], /use Button from @moonwitness\/ui\/components\/button/u);
  assert.match(violations[0], /pnpm board:ui:check/u);
  assert.match(violations[1], /use Input or Checkbox/u);
  assert.match(violations[2], /use SelectField/u);
  assert.match(violations[3], /use Textarea/u);
});

test('text, comments, and components with shared names are not treated as native controls', () => {
  const source = `
    // <button> and @moonwitness/ui/dist/components/button
    const message = '<input /> <select /> <textarea />';
    export function Form() { return <><Button /><Input /><Select /><Textarea />{message}</>; }
  `;

  assert.deepEqual(findBoardUiViolations(source), []);
});

test('internal UI dist imports fail but public subpaths pass', () => {
  const violations = findBoardUiViolations(`
    import { Button } from '@moonwitness/ui/dist/components/button.js';
    export * from '@moonwitness/ui/dist/components/input.js';
    const lazy = import('@moonwitness/ui/dist/components/select.js');
    const legacy = require('@moonwitness/ui/dist/components/textarea.js');
    import { Input } from '@moonwitness/ui/components/input';
  `);

  assert.equal(violations.length, 4);
  assert.ok(violations.every((violation) => /public @moonwitness\/ui subpath/u.test(violation)));
  assert.ok(violations.every((violation) => /pnpm board:ui:check/u.test(violation)));
});
