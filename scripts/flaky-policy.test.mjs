import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFlakyPolicy } from './flaky-policy.mjs';

const validEntry = {
  id: 'MW-123',
  test: 'board list filter renders consistently',
  owner: '@maintainer',
  issue: 'https://github.com/bjo163/moonwitness-xiv/issues/123',
  reason: 'Intermittent browser timing under investigation.',
  expiresOn: '2026-10-10',
};

const policy = (quarantine) => ({
  version: 1,
  maxRetries: 1,
  quarantine,
  protectedTestPatterns: ['security', 'auth', 'password', 'token', 'permission'],
});

test('accepts empty quarantine and a complete active entry', () => {
  assert.deepEqual(validateFlakyPolicy(policy([]), '2026-10-04'), []);
  assert.deepEqual(validateFlakyPolicy(policy([validEntry]), '2026-10-04'), []);
});

test('rejects an expired quarantine', () => {
  assert.match(
    validateFlakyPolicy(policy([{ ...validEntry, expiresOn: '2026-10-03' }]), '2026-10-04').join(
      '\n'
    ),
    /expired/u
  );
});

test('requires issue, owner, reason, and expiry metadata', () => {
  const {
    owner: _owner,
    issue: _issue,
    reason: _reason,
    expiresOn: _expiresOn,
    ...incomplete
  } = validEntry;
  const errors = validateFlakyPolicy(policy([incomplete]), '2026-10-04').join('\n');
  assert.match(errors, /owner/u);
  assert.match(errors, /issue/u);
  assert.match(errors, /reason/u);
  assert.match(errors, /expiresOn/u);
});

test('rejects security-critical tests from quarantine', () => {
  const errors = validateFlakyPolicy(
    policy([{ ...validEntry, test: 'authorization denies cross-company user' }]),
    '2026-10-04'
  );
  assert.match(errors.join('\n'), /cannot be quarantined/u);
});

test('caps retries at one and rejects duplicate quarantine IDs', () => {
  const errors = validateFlakyPolicy(
    { ...policy([validEntry, validEntry]), maxRetries: 2 },
    '2026-10-04'
  ).join('\n');
  assert.match(errors, /maxRetries/u);
  assert.match(errors, /unique/u);
});

test('accepts the GitHub login shapes an owner can actually have', () => {
  for (const owner of ['@bjo163', '@Maintainer-2', '@a']) {
    assert.deepEqual(validateFlakyPolicy(policy([{ ...validEntry, owner }]), '2026-10-04'), []);
  }
  for (const owner of ['bjo163', '@_leading', '@trailing-hyphen-', '@a'.padEnd(45, 'b')]) {
    assert.match(
      validateFlakyPolicy(policy([{ ...validEntry, owner }]), '2026-10-04').join('\n'),
      /GitHub login/u
    );
  }
});
