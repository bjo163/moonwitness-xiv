import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Rule blocks are sliced with explicit newline offsets, so normalize the CRLF that a Windows
// checkout can produce. The committed blobs stay LF; this only makes local runs deterministic.
const readSource = (path) => readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
const alertsPath = 'deploy/monitoring/whatsapp-alerts.yml';
const alerts = readSource(alertsPath);
const alertsTests = readSource('deploy/monitoring/whatsapp-alerts.test.yml');
const metrics = readSource('apps/api/src/observability/metrics.ts');
const runbook = readSource('docs/operations/whatsapp.md');

const expectedAlerts = [
  'WhatsAppGatewayUnavailable',
  'WhatsAppAccountDisconnected',
  'WhatsAppPairingQrExpired',
  'WhatsAppOutboxStalled',
  'WhatsAppOutboxDeadEvents',
  'WhatsAppAttachmentReadinessFailed',
  'WhatsAppMetricsDatabaseUnavailable',
];

function ruleBlock(source, name, nextName) {
  const start = source.indexOf(`      - alert: ${name}\n`);
  assert.notEqual(start, -1, `Missing Prometheus alert rule ${name}`);
  const next = nextName ? source.indexOf(`      - alert: ${nextName}\n`, start + 1) : -1;
  return source.slice(start, next < 0 ? undefined : next);
}

test('WhatsApp Prometheus rules define the documented seven operational alerts', () => {
  const names = [...alerts.matchAll(/^ {6}- alert: ([A-Za-z0-9_]+)$/gmu)].map(([, name]) => name);
  assert.deepEqual(names, expectedAlerts);
  const testedAlerts = [
    ...new Set(
      [...alertsTests.matchAll(/^ {8}alertname: ([A-Za-z0-9_]+)$/gmu)].map(([, name]) => name)
    ),
  ];
  assert.deepEqual(
    testedAlerts,
    expectedAlerts,
    'Every production alert must have a promtool test'
  );
  assert.match(alerts, /^groups:\r?\n {2}- name: moonwitness\.whatsapp$/mu);

  for (const [index, name] of names.entries()) {
    const block = ruleBlock(alerts, name, names[index + 1]);
    assert.match(block, /^ {8}expr: /mu, `${name} must define an expression`);
    assert.match(block, /^ {8}for: (?:\d+)(?:s|m|h)$/mu, `${name} must debounce firing`);
    assert.match(block, /^ {10}severity: (?:critical|warning)$/mu);
    assert.match(block, /^ {10}component: whatsapp$/mu);
    assert.match(block, /^ {10}summary: .+$/mu);
    assert.match(block, /^ {10}description: .+$/mu);

    const metricNames = [...new Set(block.match(/\bmoonwitness_whatsapp_[a-z0-9_]+\b/gu) ?? [])];
    for (const metric of metricNames) {
      assert.ok(metrics.includes(metric), `${name} references unimplemented metric ${metric}`);
    }
    assert.doesNotMatch(block, /company_id|phone_number|jid|user_id/iu);
  }
});

test('Blackbox probe jobs and API paths in the runbook match the alert selectors', () => {
  assert.match(alerts, /probe_success\{job="moonwitness-whatsapp-readyz"\}/u);
  assert.match(alerts, /probe_success\{job="moonwitness-api-readyz"\}/u);
  assert.match(runbook, /moonwitness-whatsapp-readyz[\s\S]*?`\/whatsapp\/readyz`/u);
  assert.match(runbook, /moonwitness-api-readyz[\s\S]*?`\/readyz`/u);
});
