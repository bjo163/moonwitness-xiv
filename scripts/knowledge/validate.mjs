#!/usr/bin/env node
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const usage = 'Usage: node scripts/knowledge/validate.mjs <dataset-directory> [--json]';
const validatorUrl = new URL('../../packages/knowledge/dist/src/index.js', import.meta.url);

function issue(file, keyword, message, issuePath = '/') {
  return { file, path: issuePath, keyword, message };
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function loadJsonTree(root, relativeDirectory, issues, parseJson) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  let entries;
  try {
    const details = await lstat(absoluteDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      issues.push(
        issue(relativeDirectory, 'directoryType', 'dataset directory must be a real directory')
      );
      return [];
    }
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    issues.push(
      issue(
        relativeDirectory,
        'filesystem',
        error instanceof Error ? error.message : 'could not read directory'
      )
    );
    return [];
  }

  const files = [];
  for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(root, relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(issue(relativePath, 'symlink', 'symbolic links are not followed'));
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await loadJsonTree(root, relativePath, issues, parseJson)));
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
    try {
      files.push({
        relativePath,
        value: parseJson(await readFile(absolutePath, 'utf8')),
      });
    } catch (error) {
      issues.push(
        issue(
          relativePath,
          'json',
          error instanceof Error ? error.message : 'file is not valid JSON'
        )
      );
    }
  }
  return files;
}

async function loadRootJson(root, filename, issues, parseJson) {
  const absolutePath = path.join(root, filename);
  try {
    const details = await lstat(absolutePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      issues.push(issue(filename, 'fileType', 'dataset manifest must be a regular file'));
      return undefined;
    }
    return { relativePath: filename, value: parseJson(await readFile(absolutePath, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    issues.push(
      issue(filename, 'json', error instanceof Error ? error.message : 'file is not valid JSON')
    );
    return undefined;
  }
}

function appendContractIssues(issues, file, validation) {
  if (!validation.valid) {
    for (const item of validation.issues) issues.push({ file, ...item });
  }
}

function sortIssues(issues) {
  issues.sort(
    (left, right) =>
      compareCodePoints(left.file, right.file) ||
      compareCodePoints(left.path, right.path) ||
      compareCodePoints(left.keyword, right.keyword) ||
      compareCodePoints(left.message, right.message)
  );
}

function derivationIdentity(derivation) {
  return derivation
    ? JSON.stringify([
        derivation.activity_id,
        derivation.input_ids,
        derivation.method_id,
        derivation.method_version,
      ])
    : undefined;
}

/** Validate the documented filesystem layout using the compiled local package. */
export async function validateKnowledgeDataset(directory, { includeData = false } = {}) {
  const {
    knowledgeRecordKinds,
    parseCanonicalJson,
    resolveKnowledgeIdentity,
    validateCanonicalKnowledgeId,
    validateKnowledgeProvenanceGraph,
    validateKnowledgeRecord,
    validateSourceArtifactManifest,
  } = await import(validatorUrl.href);
  const knownRecordKinds = new Set(knowledgeRecordKinds);
  const root = path.resolve(directory);
  const issues = [];
  let validRoot = false;
  try {
    const rootDetails = await lstat(root);
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
      issues.push(issue('.', 'directoryType', 'dataset root must be a real directory'));
    } else {
      validRoot = true;
    }
  } catch (error) {
    issues.push(
      issue(
        '.',
        'filesystem',
        error instanceof Error ? error.message : 'dataset root is unavailable'
      )
    );
  }
  if (!validRoot) {
    return {
      valid: false,
      issues,
      counts: { records: 0, aliases: 0, sourceArtifacts: 0, provenanceActivities: 0 },
    };
  }
  const recordFiles = await loadJsonTree(root, 'records', issues, parseCanonicalJson);
  const aliasesFile = await loadRootJson(root, 'aliases.json', issues, parseCanonicalJson);
  const artifactFiles = await loadJsonTree(root, 'source-artifacts', issues, parseCanonicalJson);
  const provenanceFile = await loadRootJson(root, 'provenance.json', issues, parseCanonicalJson);

  if (recordFiles.length === 0) {
    issues.push(issue('records', 'required', 'dataset must contain JSON records in records/'));
  }

  const records = new Map();
  const recordFilesById = new Map();
  for (const file of recordFiles) {
    const validation = validateKnowledgeRecord(file.value);
    appendContractIssues(issues, file.relativePath, validation);
    if (!validation.valid || typeof file.value !== 'object' || file.value === null) continue;

    const record = file.value;
    const idValidation = validateCanonicalKnowledgeId(record.id);
    if (!idValidation.valid) {
      issues.push(
        issue(
          file.relativePath,
          'canonicalId',
          idValidation.issue ?? 'record ID is not canonical',
          '/id'
        )
      );
      continue;
    }
    if (idValidation.kind !== record.kind || !knownRecordKinds.has(record.kind)) {
      issues.push(
        issue(
          file.relativePath,
          'recordKind',
          `record kind ${record.kind} does not match canonical ID kind ${idValidation.kind}`,
          '/kind'
        )
      );
      continue;
    }
    if (records.has(record.id)) {
      issues.push(
        issue(
          file.relativePath,
          'duplicateId',
          `canonical ID is already declared by ${recordFilesById.get(record.id)}`,
          '/id'
        )
      );
      continue;
    }
    records.set(record.id, record);
    recordFilesById.set(record.id, file.relativePath);
  }

  let aliases = [];
  if (aliasesFile) {
    if (!Array.isArray(aliasesFile.value)) {
      issues.push(issue('aliases.json', 'type', 'alias registry must be a JSON array'));
    } else {
      aliases = aliasesFile.value;
    }
  }
  const canonicalIds = [...records.keys()].sort();
  const aliasReferences = new Map();
  aliases.forEach((alias, index) => {
    if (typeof alias !== 'object' || alias === null) {
      issues.push(issue('aliases.json', 'type', 'alias entry must be an object', `/${index}`));
      return;
    }
    if (typeof alias.namespace !== 'string' || typeof alias.value !== 'string') {
      issues.push(
        issue('aliases.json', 'type', 'alias namespace and value must be strings', `/${index}`)
      );
      return;
    }
    const extraKeys = Object.keys(alias).filter(
      (key) => !['namespace', 'value', 'targetId'].includes(key)
    );
    if (extraKeys.length > 0) {
      issues.push(
        issue(
          'aliases.json',
          'additionalProperties',
          `alias entry contains undeclared fields: ${extraKeys.sort().join(', ')}`,
          `/${index}`
        )
      );
    }
    aliasReferences.set(JSON.stringify([alias.namespace, alias.value]), {
      namespace: alias.namespace,
      value: alias.value,
    });
  });
  for (const [key, reference] of [...aliasReferences.entries()].sort(([left], [right]) =>
    compareCodePoints(left, right)
  )) {
    const resolution = resolveKnowledgeIdentity({ alias: reference }, canonicalIds, aliases);
    if (resolution.status === 'resolved') continue;
    const detail =
      resolution.status === 'dangling-alias'
        ? `: ${resolution.canonicalId}`
        : resolution.status === 'invalid'
          ? `: ${resolution.issue}`
          : '';
    issues.push(
      issue(
        'aliases.json',
        resolution.status === 'conflict' ? 'aliasConflict' : 'aliasResolution',
        `alias ${key} ${resolution.status}${detail}`
      )
    );
  }

  const editionIds = new Map();
  for (const file of artifactFiles) {
    const validation = validateSourceArtifactManifest(file.value);
    appendContractIssues(issues, file.relativePath, validation);
    if (!validation.valid || typeof file.value !== 'object' || file.value === null) continue;

    const { edition_id: editionId } = file.value;
    const editionValidation = validateCanonicalKnowledgeId(editionId);
    if (!editionValidation.valid || editionValidation.kind !== 'Edition') {
      issues.push(
        issue(
          file.relativePath,
          'canonicalId',
          'edition_id must be a canonical mw:edition ID',
          '/edition_id'
        )
      );
    } else if (editionIds.has(editionId)) {
      issues.push(
        issue(
          file.relativePath,
          'duplicateEdition',
          `edition manifest is already declared by ${editionIds.get(editionId)}`,
          '/edition_id'
        )
      );
    } else {
      editionIds.set(editionId, file.relativePath);
      const editionRecord = records.get(editionId);
      if (!editionRecord || editionRecord.kind !== 'Edition') {
        issues.push(
          issue(
            file.relativePath,
            'unresolvedReference',
            `edition record does not resolve: ${editionId}`,
            '/edition_id'
          )
        );
      }
    }
  }

  let provenanceActivities = 0;
  let provenance;
  if (provenanceFile) {
    const validation = validateKnowledgeProvenanceGraph(provenanceFile.value);
    appendContractIssues(issues, provenanceFile.relativePath, validation);
    if (validation.valid) {
      provenance = provenanceFile.value;
      // The full records are authoritative. A separately valid graph must not
      // conceal a conflicting method, input list, or generation declaration.
      appendContractIssues(
        issues,
        provenanceFile.relativePath,
        validateKnowledgeProvenanceGraph({
          records: [...records.values()]
            .filter(
              (record) => !provenance.activities.some((activity) => activity.id === record.id)
            )
            .map(({ id, kind, derivation }) => ({
              id,
              kind,
              ...(derivation ? { derivation } : {}),
            })),
          activities: provenance.activities,
        })
      );
      provenanceActivities = provenance.activities.length;
      provenance.records.forEach((record, index) => {
        const datasetRecord = records.get(record.id);
        if (!datasetRecord) {
          issues.push(
            issue(
              'provenance.json',
              'unresolvedReference',
              `provenance record is not present in records/: ${record.id}`,
              `/records/${index}/id`
            )
          );
        } else if (datasetRecord.kind !== record.kind) {
          issues.push(
            issue(
              'provenance.json',
              'recordKind',
              `provenance kind ${record.kind} does not match dataset kind ${datasetRecord.kind}`,
              `/records/${index}/kind`
            )
          );
        }
        if (
          datasetRecord &&
          derivationIdentity(datasetRecord.derivation) !== derivationIdentity(record.derivation)
        ) {
          issues.push(
            issue(
              'provenance.json',
              'derivationMismatch',
              'graph derivation must match the actual record derivation',
              `/records/${index}/derivation`
            )
          );
        }
      });
      provenance.activities.forEach((activity, index) => {
        const activityRecord = records.get(activity.id);
        if (!activityRecord || activityRecord.kind !== 'ProvenanceActivity') {
          issues.push(
            issue(
              'provenance.json',
              'unresolvedReference',
              `provenance activity must resolve to a ProvenanceActivity record: ${activity.id}`,
              `/activities/${index}/id`
            )
          );
        }
        const references = [
          ['actor_id', activity.actor_id],
          ...activity.source_ids.map((id, sourceIndex) => [`source_ids/${sourceIndex}`, id]),
          ...activity.used_ids.map((id, usedIndex) => [`used_ids/${usedIndex}`, id]),
          ...activity.generated_ids.map((id, generatedIndex) => [
            `generated_ids/${generatedIndex}`,
            id,
          ]),
        ];
        for (const [referencePath, referencedId] of references) {
          if (!records.has(referencedId)) {
            issues.push(
              issue(
                'provenance.json',
                'unresolvedReference',
                `provenance reference does not resolve in records/: ${referencedId}`,
                `/activities/${index}/${referencePath}`
              )
            );
          }
        }
      });
    }
  }

  for (const [recordId, record] of records) {
    if (!record.derivation) continue;
    const file = recordFilesById.get(recordId);
    const activity = provenance?.activities.find(
      (candidate) => candidate.id === record.derivation.activity_id
    );
    if (!activity) {
      issues.push(
        issue(
          file,
          'unresolvedReference',
          `derivation activity does not resolve: ${record.derivation.activity_id}`,
          '/derivation/activity_id'
        )
      );
    }
    record.derivation.input_ids.forEach((inputId, index) => {
      if (!records.has(inputId)) {
        issues.push(
          issue(
            file,
            'unresolvedReference',
            `derivation input record does not resolve: ${inputId}`,
            `/derivation/input_ids/${index}`
          )
        );
      }
    });
  }

  sortIssues(issues);
  return {
    valid: issues.length === 0,
    issues,
    ...(includeData && issues.length === 0
      ? {
          dataset: {
            records: [...records.values()],
            aliases,
            sourceArtifacts: artifactFiles.map((file) => file.value),
            ...(provenance
              ? {
                  provenance: {
                    records: [...provenance.records].sort((a, b) => compareCodePoints(a.id, b.id)),
                    activities: [...provenance.activities].sort((a, b) =>
                      compareCodePoints(a.id, b.id)
                    ),
                  },
                }
              : {}),
          },
        }
      : {}),
    counts: {
      records: records.size,
      aliases: aliases.length,
      sourceArtifacts: artifactFiles.filter((file) => file.value !== undefined).length,
      provenanceActivities,
    },
  };
}

export async function main(args) {
  const jsonOutput = args.includes('--json');
  const positional = args.filter((argument) => argument !== '--json');
  if (positional.length !== 1 || ['--help', '-h'].includes(positional[0])) {
    process.stderr.write(`${usage}\n`);
    return ['--help', '-h'].includes(positional[0]) ? 0 : 2;
  }

  let result;
  try {
    result = await validateKnowledgeDataset(positional[0]);
  } catch (error) {
    process.stderr.write(
      `Could not load the compiled knowledge validator. Run \`pnpm --filter @moonwitness/knowledge build\` first.\n${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.valid) {
    const { records, aliases, sourceArtifacts, provenanceActivities } = result.counts;
    process.stdout.write(
      `Knowledge dataset valid: ${records} records, ${aliases} aliases, ${sourceArtifacts} source artifacts, ${provenanceActivities} provenance activities.\n`
    );
  } else {
    process.stderr.write(`Knowledge dataset invalid (${result.issues.length} issue(s)):\n`);
    for (const item of result.issues) {
      process.stderr.write(
        `${item.file}${item.path === '/' ? '' : item.path}: ${item.keyword}: ${item.message}\n`
      );
    }
  }
  return result.valid ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
