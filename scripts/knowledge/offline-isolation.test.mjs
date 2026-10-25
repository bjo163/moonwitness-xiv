import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import {
  ISOLATION_REQUIREMENT,
  isolationSkip,
  linuxNamespaces,
  permissionDeniesNetwork,
} from './offline-isolation.mjs';

test('a platform that can deny network access never skips the offline proof', (context) => {
  const previous = process.env.CI;
  context.after(() => {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  });
  delete process.env.CI;
  if (permissionDeniesNetwork || linuxNamespaces) assert.equal(isolationSkip(), false);
  else assert.equal(isolationSkip(), ISOLATION_REQUIREMENT);
});

test('CI never trades the offline proof for a skip, matching the recorded K1-005 rule', (context) => {
  const previous = process.env.CI;
  context.after(() => {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  });
  process.env.CI = 'true';
  assert.equal(isolationSkip(), false);
});

test('the skip reason names both accepted isolation mechanisms', () => {
  assert.match(ISOLATION_REQUIREMENT, /--allow-net/u);
  assert.match(ISOLATION_REQUIREMENT, /network namespaces/u);
});
