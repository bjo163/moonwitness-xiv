import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import {
  formatSafeServiceStatus,
  formatSafeStartupDiagnostic,
  runContainerSmoke,
} from './smoke-containers.mjs';

function harness({ request, status, reportFailure, environment, logOutput, networkPolicy } = {}) {
  const calls = [];
  const outputs = [];
  const options = [];
  const requests = [];
  const execute = (args, settings) => {
    calls.push(args);
    options.push(settings);
    if (args[0] === 'network' && args[1] === 'inspect') return networkPolicy ?? 'true';
    if (args.includes('ps')) return status ?? '';
    return args.includes('logs') ? (logOutput ?? 'Graceful shutdown complete') : '';
  };
  let port = 41000;
  return {
    calls,
    outputs,
    options,
    requests,
    run: (overrides = {}) =>
      runContainerSmoke({
        root: 'X:/fixture',
        environment: { EXISTING_ENV: 'preserved', ...environment },
        execute,
        request:
          request ??
          (async (url, requestOptions = {}) => {
            requests.push({ url, ...requestOptions });
            if (url.endsWith('/auth/login')) {
              return { ok: true, body: JSON.stringify({ data: { access_token: 'smoke-token' } }) };
            }
            if (url.includes('/mw%3Asource%3Atanzil-quran-text')) {
              return { ok: true, body: 'mw:source:tanzil-quran-text' };
            }
            if (url.includes('/mw%3Aedition%3Atanzil-quran-text')) {
              return { ok: true, body: 'mw:source:tanzil-quran-text Q7:46' };
            }
            if (url.includes('/mw%3Asource%3Aebible-webp-protestant')) {
              return { ok: true, body: 'mw:source:ebible-webp-protestant' };
            }
            if (url.includes('/mw%3Aedition%3Awebp-protestant')) {
              return {
                ok: true,
                body: 'In the beginning, God created the heavens and the earth.',
              };
            }
            return { ok: true, body: 'MoonWitness Enterprise ORM API "status":"healthy"' };
          }),
        pause: async () => {},
        reportFailure: reportFailure ?? ((phase) => outputs.push(phase)),
        getPort: async () => (port += 1),
        processId: 55,
        now: () => 1234,
        ...overrides,
      }),
  };
}

test('runs isolated Compose smoke phases and always removes only its project volumes', async () => {
  const fixture = harness();
  await fixture.run();

  const commandTexts = fixture.calls.map((args) => args.join(' '));
  assert.match(commandTexts[0], /--wait-timeout 180 postgres$/u);
  assert.ok(commandTexts[1].includes('network inspect moonwitness-smoke-55-1234_default'));
  assert.match(commandTexts[1], /--format \{\{\.Internal\}\}$/u);
  assert.match(commandTexts[2], /up --detach --build --no-deps api$/u);
  assert.match(commandTexts[3], /up --detach --build --no-deps board$/u);
  assert.match(commandTexts[0], /--project-name moonwitness-smoke-55-1234/u);
  assert.ok(commandTexts.some((entry) => entry.includes('stop --timeout 45 api')));
  assert.ok(commandTexts.some((entry) => entry.endsWith('logs api')));
  assert.equal(
    commandTexts.at(-1).replaceAll('\\', '/'),
    '--project-name moonwitness-smoke-55-1234 -f X:/fixture/docker-compose.production.yml -f X:/fixture/docker-compose.smoke.yml down --volumes --remove-orphans'
  );
  assert.equal(fixture.options[0].environment.COMPOSE_PROJECT_NAME, 'moonwitness-smoke-55-1234');
  assert.equal(fixture.options[0].environment.EXISTING_ENV, 'preserved');
  assert.notEqual(
    fixture.options[0].environment.API_PORT,
    fixture.options[0].environment.BOARD_PORT
  );
  const loginRequest = fixture.requests.find(({ url }) => url.endsWith('/auth/login'));
  assert.equal(loginRequest.method, 'POST');
  assert.deepEqual(JSON.parse(loginRequest.body), {
    login: 'superadmin',
    password: 'ci-smoke-superadmin-password',
  });
  const corpusRequests = fixture.requests.filter(({ url }) => url.includes('/api/corpus/'));
  assert.equal(corpusRequests.length, 4);
  assert.ok(corpusRequests.every(({ headers }) => headers.authorization === 'Bearer smoke-token'));
  assert.ok(corpusRequests.some(({ url }) => url.includes('mw%3Aedition%3Awebp-protestant')));
});

test('uses already-verified images without rebuilding them for release smoke', async () => {
  const fixture = harness({ environment: { SMOKE_USE_PREBUILT_IMAGES: 'true' } });
  await fixture.run();

  const starts = fixture.calls
    .filter((args) => args.includes('up'))
    .map((args) => args.slice(args.indexOf('up')).join(' '));
  assert.deepEqual(starts, [
    'up --detach --wait --wait-timeout 180 postgres',
    'up --detach --no-build --no-deps api',
    'up --detach --no-build --no-deps board',
  ]);
});

test('requires the Docker smoke network to deny external connectivity before starting the API', async () => {
  const fixture = harness({ networkPolicy: 'false' });

  await assert.rejects(fixture.run(), /Container smoke failed during network_egress_policy/u);

  assert.deepEqual(fixture.outputs, ['network_egress_policy']);
  assert.ok(!fixture.calls.some((args) => args.includes('up') && args.includes('api')));
  assert.match(fixture.calls.at(-1).join(' '), /down --volumes --remove-orphans$/u);
});

test('declares the smoke Compose default network internal', async () => {
  const compose = await readFile(new URL('../docker-compose.smoke.yml', import.meta.url), 'utf8');
  assert.match(compose, /networks:\s+default:\s+internal:\s+true/u);
});

test('runs the egress-denied smoke stack on the local attachment driver', async () => {
  const fixture = harness();
  await fixture.run();

  const environment = fixture.options.find((settings) => settings.environment)?.environment;
  assert.equal(environment.ATTACHMENT_STORAGE_DRIVER, 'local');
  assert.equal(environment.EXISTING_ENV, 'preserved');
  assert.ok(environment.ATTACHMENT_S3_ACCESS_KEY);
  assert.ok(environment.ATTACHMENT_S3_SECRET_KEY);
});

test('reports the failing phase and still cleans up after an unhealthy endpoint', async () => {
  const fixture = harness({ request: async () => ({ ok: false, body: 'unavailable' }) });
  await assert.rejects(fixture.run(), /Container smoke failed during api_readiness/u);
  assert.deepEqual(fixture.outputs, ['api_readiness']);
  assert.ok(fixture.calls.some((args) => args.includes('ps')));
  assert.ok(!fixture.calls.some((args) => args.at(-1) === 'board'));
  assert.match(fixture.calls.at(-1).join(' '), /down --volumes --remove-orphans$/u);
});

test('reports only allowlisted service status fields when API readiness fails', async () => {
  const failures = [];
  const fixture = harness({
    request: async (url) =>
      url.endsWith('/readyz')
        ? { ok: false, body: 'unavailable' }
        : { ok: true, body: 'MoonWitness Enterprise ORM API' },
    status: JSON.stringify([
      {
        Service: 'api',
        State: 'restarting',
        Health: 'unhealthy',
        ExitCode: 1,
        JWT_SECRET: 'must-not-be-printed',
      },
      { Service: 'postgres', State: 'running', Health: 'healthy', ExitCode: 0 },
      { Service: 'unknown-service', State: 'running', Health: 'healthy', ExitCode: 0 },
    ]),
    reportFailure: (phase, serviceStatus) => failures.push({ phase, serviceStatus }),
  });

  await assert.rejects(fixture.run(), /Container smoke failed during api_readiness/u);
  assert.deepEqual(failures, [
    {
      phase: 'api_readiness',
      serviceStatus: 'api/restarting/unhealthy/1, postgres/running/healthy/0',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(failures), /must-not-be-printed/u);
});

test('safe service status ignores raw fields and malformed output', () => {
  assert.equal(
    formatSafeServiceStatus(
      '{"Service":"api","State":"running","Health":"healthy","ExitCode":0,"Password":"hidden"}'
    ),
    'api/running/healthy/0'
  );
  assert.equal(formatSafeServiceStatus('not-json with database credentials'), 'unavailable');
});

test('startup diagnostic parser keeps only allowlisted fields and redacts credentials', () => {
  const raw =
    'api-1 | {"event":"api_startup_failure","context":{"name":"DatabaseError","code":"ECONNREFUSED","message":"connect postgresql://postgres:secret@db/app JWT_SECRET=hidden","stack":"do not print","token":"hidden"}}';

  const diagnostic = formatSafeStartupDiagnostic(raw);

  assert.equal(
    diagnostic,
    'name=DatabaseError code=ECONNREFUSED message=connect [redacted-url] JWT_SECRET=[redacted]'
  );
  assert.doesNotMatch(diagnostic, /top-secret|hidden|stack=|token=|postgresql:\/\//iu);
  assert.equal(
    formatSafeStartupDiagnostic('api-1 | startup failed with raw password'),
    'unavailable'
  );
});

test('captures sanitized API startup context before removing the smoke containers', async () => {
  const failures = [];
  const fixture = harness({
    request: async (url) =>
      url.endsWith('/readyz')
        ? { ok: false, body: 'unavailable' }
        : { ok: true, body: 'MoonWitness Enterprise ORM API' },
    logOutput:
      'api-1 | {"event":"api_startup_failure","context":{"name":"DatabaseError","code":"ECONNREFUSED","message":"postgresql://postgres:secret@db/app"}}',
    reportFailure: (phase, serviceStatus, startupDiagnostic) =>
      failures.push({ phase, serviceStatus, startupDiagnostic }),
  });

  await assert.rejects(fixture.run(), /Container smoke failed during api_readiness/u);

  assert.deepEqual(failures, [
    {
      phase: 'api_readiness',
      serviceStatus: 'unavailable',
      startupDiagnostic: 'name=DatabaseError code=ECONNREFUSED message=[redacted-url]',
    },
  ]);
  const startupLogs = fixture.calls.findIndex((args) => args.includes('logs'));
  const cleanup = fixture.calls.findIndex((args) => args.includes('down'));
  assert.ok(startupLogs >= 0 && startupLogs < cleanup);
  assert.doesNotMatch(JSON.stringify(failures), /secret/u);
});

test('preserves a smoke failure when cleanup also fails and reports the cleanup failure', async () => {
  const calls = [];
  let port = 42000;
  await assert.rejects(
    runContainerSmoke({
      root: 'X:/fixture',
      environment: {},
      processId: 1,
      now: () => 2,
      getPort: async () => (port += 1),
      pause: async () => {},
      reportFailure: () => {},
      request: async () => ({ ok: false, body: '' }),
      execute(args) {
        calls.push(args);
        if (args.includes('down')) throw new Error('cleanup failure');
        if (args[0] === 'network' && args[1] === 'inspect') return 'true';
        return '';
      },
    }),
    /Container smoke failed during api_readiness\. Cleanup also failed\./u
  );
  assert.ok(calls.at(-1).includes('down'));
});
