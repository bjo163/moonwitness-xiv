import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedAllowlistExpressions, validateGitleaksSetup } from './check-gitleaks-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [workflow, config] = await Promise.all([
  readFile(path.join(root, '.github/workflows/gitleaks.yml'), 'utf8'),
  readFile(path.join(root, '.gitleaks.toml'), 'utf8'),
]);
const ruleBlock = config.match(
  /\[\[rules\]\]\s*id\s*=\s*"moonwitness-runtime-secret"([\s\S]*?)(?=\n\[\[|\s*$)/u
)?.[1];
const ruleSource = ruleBlock?.match(/regex\s*=\s*'''(.*?)'''/su)?.[1];
assert.ok(ruleSource, 'custom rule must define a detector expression');
const rule = new RegExp(ruleSource.replace(/^\(\?i\)/u, ''), 'iu');
const entropy = (value) => {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
};

test('accepts least-privilege full-history scanning with exact reviewed fixtures', () => {
  assert.deepEqual(validateGitleaksSetup(workflow, config), []);
});

test('synthetic resurrection fixture allowlist matches only its exact line', () => {
  const [source] = expectedAllowlistExpressions.slice(3, 4);
  const matcher = new RegExp(source, 'u');
  const line = "    idempotency_key: 'synthetic-resurrection-revoke-001',";

  assert.match(line, matcher);
  assert.match(`${line}\r`, matcher);
  assert.doesNotMatch(
    line.replace('synthetic-resurrection-revoke-001', 'synthetic-resurrection-revoke-002'),
    matcher
  );
  assert.doesNotMatch(line.replace('idempotency_key', 'idempotencyKey'), matcher);
  assert.doesNotMatch(`${line} // changed`, matcher);
});

test('historical scanner exceptions match only the seven exact false-positive source lines', () => {
  const tokenHash = [
    '269a6e000da6fa28',
    '8380cf36ec127df0',
    '9cc86d6a38a1d461',
    '3a975b54d3664d5a',
  ].join('');
  const historicalLines = [
    ['/^', String.raw`\s*`, '"tokensSha256": "', tokenHash, '"$/u,'].join(''),
    ['/^', String.raw`\s*`, 'idempotency', 'Key: ', "'duplicate-", 'vote-0001', "',$/u,"].join(''),
    ['/^', String.raw`\s*`, 'idempotency', 'Key: ', "'reject-", 'decision-0001', "',$/u,"].join(''),
    ["'^", String.raw`\\s*`, '"tokensSha256": "', tokenHash, '"$', "',"].join(''),
    ['"^', String.raw`\\s*`, 'idempotency', 'Key: ', "'duplicate-", 'vote-0001', '\',$"', ','].join(
      ''
    ),
    [
      '"^',
      String.raw`\\s*`,
      'idempotency',
      'Key: ',
      "'reject-",
      'decision-0001',
      '\',$"',
      ',',
    ].join(''),
    [
      '- Add adapter fixtures for API pagination, missing',
      '/',
      'duplicate checks, stale snapshots, revoked permissions, and malformed/untrusted webhook or issue events.',
    ].join(''),
  ];
  const matchers = expectedAllowlistExpressions.slice(4).map((source) => new RegExp(source, 'u'));

  assert.equal(historicalLines.length, matchers.length);
  for (const [index, line] of historicalLines.entries()) {
    assert.match(line, matchers[index]);
    assert.doesNotMatch(`${line}extra`, matchers[index]);
  }
});

test('rejects workflow trust-boundary and allowlist regressions', () => {
  const invalidWorkflow = workflow.replace('pull_request:', 'pull_request_target:');
  const invalidConfig = config.replace('duplicate-vote-0001', 'altered-fixture');
  assert.ok(
    validateGitleaksSetup(invalidWorkflow, config).some((issue) => /privileged PR/u.test(issue))
  );
  assert.ok(
    validateGitleaksSetup(workflow, invalidConfig).some((issue) => /reviewed fixture/u.test(issue))
  );
  assert.ok(
    validateGitleaksSetup(workflow, config.replace('useDefault = true', 'useDefault = false')).some(
      (issue) => /built-in secret detection rules/u.test(issue)
    )
  );
  assert.ok(
    validateGitleaksSetup(
      workflow,
      config.replace('"WHATSAPP_SESSION_KEY"]', '"METRICS_TOKEN_UNUSED"]')
    ).some((issue) => /WhatsApp credentials/u.test(issue))
  );
  assert.ok(
    validateGitleaksSetup(
      workflow,
      config.replace('[A-Za-z0-9_+/=-]{32,}', '[A-Za-z0-9_-]{32,}')
    ).some((issue) => /WhatsApp credentials/u.test(issue)),
    'a base64url-only value class must not pass the guard for padded session keys'
  );
  assert.ok(
    validateGitleaksSetup(workflow, config.replace('(?:#.*)?\\r?$', '(?:#.*)?$')).some((issue) =>
      /WhatsApp credentials/u.test(issue)
    ),
    'dropping CRLF tolerance would let a secret commit read as a clean scan'
  );
});

test('MoonWitness custom rule catches random runtime credentials but not weak placeholders', () => {
  const syntheticSecret = randomBytes(48).toString('base64url');
  const match = `JWT_SECRET=${syntheticSecret}`.match(rule);
  assert.equal(match?.[1], syntheticSecret);
  assert.ok(entropy(syntheticSecret) >= 4.2);

  // A Baileys session key is padded standard base64, so `+`, `/` and `=` must be inside the value.
  for (const [name, value] of [
    ['WHATSAPP_INTERNAL_TOKEN', randomBytes(48).toString('base64url')],
    ['WHATSAPP_SESSION_KEY', randomBytes(32).toString('base64')],
  ]) {
    assert.equal(`${name}=${value}`.match(rule)?.[1], value);
    assert.equal(`${name}: "${value}"`.match(rule)?.[1], value);
    assert.ok(entropy(value) >= 4.2, `${name} sample must clear the entropy gate`);
  }

  const placeholder = 'ci-only-secret-that-is-at-least-32-characters-long';
  const placeholderMatch = `JWT_SECRET=${placeholder}`.match(rule);
  assert.equal(placeholderMatch?.[1], placeholder);
  assert.ok(entropy(placeholder) < 4.2);
  assert.equal(`DATABASE_URL=${syntheticSecret}`.match(rule), null);
  assert.equal(`const fixture = /^JWT_SECRET=${syntheticSecret}$/u;`.match(rule), null);
  assert.equal(
    `  process.env.WHATSAPP_SESSION_KEY = previousSessionKey;`.match(rule),
    null,
    'reading a runtime credential must not look like committing one'
  );
  assert.equal(
    `WHATSAPP_INTERNAL_TOKEN=${syntheticSecret}\r`.match(rule)?.[1],
    syntheticSecret,
    'a CRLF-terminated secret must not slip past the end-of-line anchor'
  );
});

test('committed non-secret placeholders for the pinned names stay below the entropy gate', async () => {
  const callers = [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'docker-compose.yml',
    'docker-compose.production.yml',
    '.env.example',
    '.env.production.example',
    'scripts/smoke-containers.mjs',
  ];
  const matched = [];
  for (const file of callers) {
    const contents = await readFile(path.join(root, file), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(rule);
      if (!match) continue;
      matched.push(`${file}: ${line.trim()}`);
      assert.ok(
        entropy(match[1]) < 4.2,
        `${file} now commits a placeholder the scanner would flag: ${line.trim()}`
      );
    }
  }
  assert.ok(matched.length >= 4, `placeholder sweep must not be vacuous: ${matched.join('\n')}`);
});
