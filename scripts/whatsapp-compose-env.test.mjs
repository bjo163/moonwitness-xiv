import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const composeFiles = ['docker-compose.production.yml', 'docker-compose.prd.yml'];

function serviceBlock(source, name) {
  const start = source.search(new RegExp(`^  ${name}:\\s*$`, 'mu'));
  assert.notEqual(start, -1, `Compose must define ${name}`);
  const remainder = source.slice(start + 1);
  const nextService = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/mu);
  return source.slice(start, nextService === -1 ? undefined : start + 1 + nextService);
}

for (const file of composeFiles) {
  test(`${file} scopes WhatsApp gateway and webhook secrets to the required services`, () => {
    const source = readFileSync(file, 'utf8');
    const commonEnvironment = source.match(
      /^x-app-environment:\s*&[^\r\n]+\r?\n([\s\S]*?)(?=^x-whatsapp-gateway-credentials:|^services:)/mu
    );
    const credentials = source.match(
      /^x-whatsapp-gateway-credentials:\s*&[^\r\n]+\r?\n([\s\S]*?)(?=^services:)/mu
    );
    const webhookEnvironment = source.match(
      /^x-whatsapp-webhook-environment:\s*&[^\r\n]+\r?\n([\s\S]*?)(?=^services:)/mu
    );
    assert.ok(commonEnvironment, 'Compose must define a shared non-provider environment');
    assert.ok(credentials, 'Compose must define a dedicated GoWA credentials environment');
    assert.ok(webhookEnvironment, 'Compose must define a dedicated webhook environment');
    assert.match(credentials[1], /^ {2}WHATSAPP_GATEWAY_USERNAME:/mu);
    assert.match(credentials[1], /^ {2}WHATSAPP_GATEWAY_PASSWORD:/mu);
    assert.match(webhookEnvironment[1], /^ {2}WHATSAPP_WEBHOOK_URL:/mu);
    assert.match(webhookEnvironment[1], /^ {2}WHATSAPP_WEBHOOK_SECRET:/mu);
    assert.doesNotMatch(
      commonEnvironment[1],
      /WHATSAPP_GATEWAY_(?:USERNAME|PASSWORD)|WHATSAPP_WEBHOOK_SECRET/u
    );

    const environmentAnchors = file.endsWith('prd.yml')
      ? {
          app: 'app-environment',
          gateway: 'whatsapp-gateway-credentials',
          webhook: 'whatsapp-webhook-environment',
        }
      : {
          app: 'app_environment',
          gateway: 'whatsapp_gateway_credentials',
          webhook: 'whatsapp_webhook_environment',
        };
    const expectedApiEnvironmentMerge = new RegExp(
      `^ {6}<<:\\s*\\[\\*${environmentAnchors.app},\\s*\\*${environmentAnchors.gateway},\\s*\\*${environmentAnchors.webhook}\\]$`,
      'mu'
    );
    const expectedOutboxEnvironmentMerge = new RegExp(
      `^ {6}<<:\\s*\\[\\*${environmentAnchors.app},\\s*\\*${environmentAnchors.gateway}\\]$`,
      'mu'
    );
    assert.match(serviceBlock(source, 'api'), expectedApiEnvironmentMerge);
    assert.match(serviceBlock(source, 'outbox-worker'), expectedOutboxEnvironmentMerge);
    assert.doesNotMatch(serviceBlock(source, 'outbox-worker'), /WHATSAPP_WEBHOOK_SECRET/u);
    for (const name of ['jobs-worker', 'jobs-scheduler']) {
      const block = serviceBlock(source, name);
      assert.doesNotMatch(block, /WHATSAPP_GATEWAY_(?:USERNAME|PASSWORD)|WHATSAPP_WEBHOOK_SECRET/u);
      assert.doesNotMatch(block, new RegExp(`\\*${environmentAnchors.gateway}`, 'u'));
    }
    const board = serviceBlock(source, 'board');
    assert.doesNotMatch(board, /WHATSAPP_GATEWAY_(?:USERNAME|PASSWORD)|WHATSAPP_WEBHOOK_SECRET/u);
  });
}
