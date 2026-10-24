import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const alertsPath = 'deploy/monitoring/whatsapp-alerts.yml';
const alerts = readFileSync(alertsPath, 'utf8');
const alertsTests = readFileSync('deploy/monitoring/whatsapp-alerts.test.yml', 'utf8');
const metrics = readFileSync('apps/api/src/observability/metrics.ts', 'utf8');
const runbook = readFileSync('docs/operations/whatsapp.md', 'utf8');

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
  const names = [...alerts.matchAll(/^      - alert: ([A-Za-z0-9_]+)$/gmu)].map(([, name]) => name);
  assert.deepEqual(names, expectedAlerts);
  const testedAlerts = [
    ...new Set(
      [...alertsTests.matchAll(/^        alertname: ([A-Za-z0-9_]+)$/gmu)].map(([, name]) => name)
    ),
  ];
  assert.deepEqual(
    testedAlerts,
    expectedAlerts,
    'Every production alert must have a promtool test'
  );
  assert.match(alerts, /^groups:\r?\n  - name: moonwitness\.whatsapp$/mu);

  for (const [index, name] of names.entries()) {
    const block = ruleBlock(alerts, name, names[index + 1]);
    assert.match(block, /^        expr: /mu, `${name} must define an expression`);
    assert.match(block, /^        for: (?:\d+)(?:s|m|h)$/mu, `${name} must debounce firing`);
    assert.match(block, /^          severity: (?:critical|warning)$/mu);
    assert.match(block, /^          component: whatsapp$/mu);
    assert.match(block, /^          summary: .+$/mu);
    assert.match(block, /^          description: .+$/mu);

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
