import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(root, '.github', 'workflows', 'gitleaks.yml');
const configPath = path.join(root, '.gitleaks.toml');
const actionReference = /gitleaks\/gitleaks-action@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/;
const exactLine = (segments) => new RegExp(segments.join(''), 'u');
const runtimeSecretNames = [
  'JWT_SECRET',
  'METRICS_TOKEN',
  'WHATSAPP_INTERNAL_TOKEN',
  'WHATSAPP_SESSION_KEY',
];
// WhatsApp stores an AES-GCM session key as padded base64, so a base64url-only class would miss it.
const paddedBase64Class = '[A-Za-z0-9_+/=-]{32,}';
const runtimeSecretRulePin = new RegExp(
  [
    String.raw`\[\[rules\]\][\s\S]*?id\s*=\s*"moonwitness-runtime-secret"`,
    String.raw`[\s\S]*?secretGroup\s*=\s*1[\s\S]*?entropy\s*=\s*4\.2[\s\S]*?keywords\s*=\s*\[`,
    runtimeSecretNames.map((name) => `"${name}"`).join(String.raw`\s*,\s*`),
    String.raw`\]`,
  ].join(''),
  'u'
);
const tokenHash = [
  '269a6e000da6fa28',
  '8380cf36ec127df0',
  '9cc86d6a38a1d461',
  '3a975b54d3664d5a',
].join('');
const allowedLines = [
  exactLine(['^', String.raw`\s*`, '"tokensSha256": "', tokenHash, '"$']),
  exactLine(['^', String.raw`\s*`, 'idempotency', 'Key: ', "'duplicate-", 'vote-0001', "',$"]),
  exactLine(['^', String.raw`\s*`, 'idempotency', 'Key: ', "'reject-", 'decision-0001', "',$"]),
  exactLine([
    '^',
    String.raw`\s*`,
    'idempotency_key: ',
    "'synthetic-resurrection-revoke-001',",
    String.raw`\r?$`,
  ]),
];
const exactHistoricalLine = (segments) =>
  new RegExp(`^\\s*${segments.join('').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u').source;
const historicalFalsePositiveLines = [
  exactHistoricalLine(['/^', String.raw`\s*`, '"tokensSha256": "', tokenHash, '"$/u,']),
  exactHistoricalLine([
    '/^',
    String.raw`\s*`,
    'idempotency',
    'Key: ',
    "'duplicate-",
    'vote-0001',
    "',$/u,",
  ]),
  exactHistoricalLine([
    '/^',
    String.raw`\s*`,
    'idempotency',
    'Key: ',
    "'reject-",
    'decision-0001',
    "',$/u,",
  ]),
  exactHistoricalLine(["'^", String.raw`\\s*`, '"tokensSha256": "', tokenHash, '"$', "',"]),
  exactHistoricalLine([
    '"^',
    String.raw`\\s*`,
    'idempotency',
    'Key: ',
    "'duplicate-",
    'vote-0001',
    '\',$"',
    ',',
  ]),
  exactHistoricalLine([
    '"^',
    String.raw`\\s*`,
    'idempotency',
    'Key: ',
    "'reject-",
    'decision-0001',
    '\',$"',
    ',',
  ]),
  String.raw`^\s*- Add adapter fixtures for API pagination, missing[/]duplicate checks, stale snapshots, revoked permissions, and malformed/untrusted webhook or issue events\.$`,
];
export const expectedAllowlistExpressions = [
  ...allowedLines.map(({ source }) => source),
  ...historicalFalsePositiveLines,
];

export function validateGitleaksSetup(workflow, config) {
  const problems = [];
  const runtimeSecretRule = config.match(
    /\[\[rules\]\]\s*id\s*=\s*"moonwitness-runtime-secret"([\s\S]*?)(?=\n\[\[|\s*$)/u
  )?.[1];
  const runtimeSecretRegex = runtimeSecretRule?.match(/regex\s*=\s*'''(.*?)'''/su)?.[1];
  if (!actionReference.test(workflow))
    problems.push('Gitleaks Action must use a pinned full SHA and version.');
  if (!/^\s*contents:\s*read\s*$/m.test(workflow))
    problems.push('Gitleaks workflow must grant contents: read.');
  if (
    /pull_request_target|permissions:\s*write|GITLEAKS_ENABLE_COMMENTS:\s*['"]?true/i.test(workflow)
  ) {
    problems.push(
      'Gitleaks must not use privileged PR triggers, write permissions, or PR comments.'
    );
  }
  if (!/fetch-depth:\s*0/.test(workflow)) problems.push('Gitleaks must scan full Git history.');
  if (!/\[extend\][\s\S]*?\buseDefault\s*=\s*true\b/u.test(config)) {
    problems.push('Custom Gitleaks config must extend the built-in secret detection rules.');
  }
  if (!/regexTarget\s*=\s*"line"/.test(config))
    problems.push('Allowlist must match exact lines, not whole files or commits.');

  // A CRLF-terminated line otherwise escapes the `$` anchor and reads as a clean scan.
  if (
    !runtimeSecretRulePin.test(config) ||
    !runtimeSecretRegex?.includes(`(${paddedBase64Class})`) ||
    !runtimeSecretRegex.endsWith(String.raw`\r?$`)
  ) {
    problems.push(
      'MoonWitness runtime secret detection must cover high-entropy JWT, metrics, and WhatsApp credentials.'
    );
  }

  const allowlistStart = config.indexOf('[allowlist]');
  const customRulesStart = config.indexOf('[[rules]]', allowlistStart);
  const allowlistConfig =
    allowlistStart < 0
      ? ''
      : config.slice(allowlistStart, customRulesStart < 0 ? undefined : customRulesStart);
  const configuredLines = [...allowlistConfig.matchAll(/'''(.*?)'''/gs)].map((match) => match[1]);
  if (configuredLines.length !== expectedAllowlistExpressions.length) {
    problems.push(
      'Allowlist must contain exactly the reviewed synthetic fixture and historical false-positive lines.'
    );
  } else {
    for (const [index, expression] of configuredLines.entries()) {
      const expected = expectedAllowlistExpressions[index];
      if (expression !== expected)
        problems.push(`Allowlist entry ${index + 1} differs from its reviewed fixture.`);
    }
  }
  return problems;
}

async function main() {
  const [workflow, config] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(configPath, 'utf8'),
  ]);
  const problems = validateGitleaksSetup(workflow, config);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Gitleaks workflow and exact-line allowlist are valid.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
