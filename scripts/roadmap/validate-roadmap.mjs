import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { milestonePattern, parseTaskId, taskIdPattern, taskIdSource } from './task-ids.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const allowedTaskKeys = new Set([
  'id',
  'title',
  'milestone',
  'dependsOn',
  'output',
  'detailFile',
  'labels',
  'priority',
  'assignee',
  'status',
  'evidence',
]);
const allowedRootKeys = new Set(['schemaVersion', 'description', 'tasks']);

/** @typedef {'todo' | 'in_progress' | 'blocked' | 'complete'} TaskStatus */
/** @typedef {'p0' | 'p1' | 'p2' | 'p3'} TaskPriority */
/**
 * @typedef {object} RoadmapTask
 * @property {string} id
 * @property {string} title
 * @property {string} milestone
 * @property {string[]} dependsOn
 * @property {string} output
 * @property {string} detailFile
 * @property {string[]=} labels
 * @property {TaskPriority=} priority
 * @property {string=} assignee
 * @property {TaskStatus=} status
 * @property {string=} evidence
 */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return duplicate property names, scoped to each JSON object rather than globally. */
export function findDuplicateJsonObjectKeys(source) {
  const containers = [];
  const duplicates = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      let escaped = false;
      for (index += 1; index < source.length; index += 1) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') break;
      }
      const container = containers.at(-1);
      if (container?.kind === 'object' && container.expectingKey) {
        const key = JSON.parse(source.slice(start, index + 1));
        if (container.keys.has(key)) duplicates.push(key);
        container.keys.add(key);
        container.expectingKey = false;
      }
    } else if (character === '{') {
      containers.push({ kind: 'object', expectingKey: true, keys: new Set() });
    } else if (character === '[') {
      containers.push({ kind: 'array' });
    } else if (character === '}' || character === ']') {
      containers.pop();
    } else if (character === ',' && containers.at(-1)?.kind === 'object') {
      containers.at(-1).expectingKey = true;
    }
  }
  return duplicates;
}

function isSafeRoadmapPath(value, prefix) {
  if (typeof value !== 'string' || value.includes('\\') || path.posix.isAbsolute(value))
    return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && value.startsWith(prefix) && !value.split('/').includes('..');
}

function evidenceLinksFromLine(line) {
  return [...line.matchAll(/\[([^\]]+)\]\((docs\/roadmap\/evidence\/[^)#]+\.md)\)/gu)].map(
    ([, label, filePath]) => ({ label, filePath })
  );
}

function evidenceLabelCoversTask(label, id) {
  if (label.includes(id)) return true;
  const range = new RegExp(`^(${taskIdSource})[–-](${taskIdSource})$`, 'u').exec(label);
  if (!range) return false;
  const start = parseTaskId(range[1]);
  const end = parseTaskId(range[2]);
  const task = parseTaskId(id);
  if (!start || !end || !task || start.milestone !== end.milestone) return false;
  return (
    task.milestone === start.milestone &&
    task.ordinal >= start.ordinal &&
    task.ordinal <= end.ordinal
  );
}

function linkedEvidenceForTask(roadmap, id, documents) {
  const checkbox = new RegExp(`^\\s*-\\s*\\[[ xX]\\]\\s+${id}\\b`, 'u');
  const line = roadmap.split(/\r?\n/u).find((candidate) => checkbox.test(candidate));
  if (line === undefined) return [];
  return evidenceLinksFromLine(line)
    .filter(({ label, filePath }) => evidenceLabelCoversTask(label, id) && documents.has(filePath))
    .map(({ filePath }) => filePath);
}

/**
 * @param {unknown} input
 * @param {string} roadmap
 * @param {ReadonlyMap<string, string>} documents
 * @returns {string[]}
 */
export function validateRoadmapIndex(input, roadmap, documents) {
  const problems = [];
  if (!isRecord(input)) return ['Task index root must be an object.'];
  for (const key of Object.keys(input)) {
    if (!allowedRootKeys.has(key)) problems.push(`Task index has unsupported property "${key}".`);
  }
  if (input.schemaVersion !== 1) problems.push('Task index schemaVersion must equal 1.');
  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    problems.push('Task index description must be a non-empty string.');
  }
  if (!Array.isArray(input.tasks)) return [...problems, 'Task index tasks must be an array.'];

  /** @type {RoadmapTask[]} */
  const tasks = [];
  const seenIds = new Set();
  for (const [index, candidate] of input.tasks.entries()) {
    const prefix = `tasks[${index}]`;
    if (!isRecord(candidate)) {
      problems.push(`${prefix} must be an object.`);
      continue;
    }
    for (const key of Object.keys(candidate)) {
      if (!allowedTaskKeys.has(key)) problems.push(`${prefix} has unsupported property "${key}".`);
    }
    const id = candidate.id;
    if (typeof id !== 'string' || !taskIdPattern.test(id)) {
      problems.push(
        `${prefix}.id must use a stable M<n>.<two-digit> or K<n>-<three-digit> task ID.`
      );
      continue;
    }
    if (seenIds.has(id)) problems.push(`${id} is duplicated in tasks.json.`);
    seenIds.add(id);
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
      problems.push(`${id}.title must be a non-empty string.`);
    }
    if (typeof candidate.milestone !== 'string' || !milestonePattern.test(candidate.milestone)) {
      problems.push(`${id}.milestone must use the M<n> or K<n> format.`);
    } else if (parseTaskId(id)?.milestone !== candidate.milestone) {
      problems.push(`${id}.milestone must match its task ID prefix.`);
    }
    if (
      !Array.isArray(candidate.dependsOn) ||
      candidate.dependsOn.some(
        (dependency) => typeof dependency !== 'string' || !taskIdPattern.test(dependency)
      )
    ) {
      problems.push(`${id}.dependsOn must contain stable task IDs.`);
    } else if (new Set(candidate.dependsOn).size !== candidate.dependsOn.length) {
      problems.push(`${id}.dependsOn contains duplicates.`);
    }
    if (typeof candidate.output !== 'string' || candidate.output.trim().length === 0) {
      problems.push(`${id}.output must be a non-empty string.`);
    }
    if (!isSafeRoadmapPath(candidate.detailFile, 'docs/roadmap/')) {
      problems.push(`${id}.detailFile must be a safe repository-relative docs/roadmap path.`);
    } else if (!/^docs\/roadmap\/[a-z0-9-]+\.md$/u.test(candidate.detailFile)) {
      problems.push(`${id}.detailFile must reference one roadmap Markdown card file.`);
    } else if (!documents.has(candidate.detailFile)) {
      problems.push(`${id}.detailFile does not exist: ${candidate.detailFile}.`);
    } else {
      const card = documents.get(candidate.detailFile) ?? '';
      const heading = new RegExp(`^##\\s+${id.replace('.', '\\.')}\\s+(?:—|-|–)`, 'mu');
      if (!heading.test(card))
        problems.push(`${id} has no matching card heading in ${candidate.detailFile}.`);
    }
    if (
      candidate.labels !== undefined &&
      (!Array.isArray(candidate.labels) ||
        candidate.labels.some(
          (label) => typeof label !== 'string' || !/^[a-z0-9][a-z0-9:-]{0,49}$/u.test(label)
        ))
    ) {
      problems.push(`${id}.labels must be unique lowercase namespace-compatible labels.`);
    } else if (
      Array.isArray(candidate.labels) &&
      new Set(candidate.labels).size !== candidate.labels.length
    ) {
      problems.push(`${id}.labels contains duplicates.`);
    }
    if (
      candidate.priority !== undefined &&
      !['p0', 'p1', 'p2', 'p3'].includes(candidate.priority)
    ) {
      problems.push(`${id}.priority must be p0, p1, p2, or p3.`);
    }
    if (
      candidate.assignee !== undefined &&
      (typeof candidate.assignee !== 'string' || !/^[A-Za-z0-9-]{1,39}$/u.test(candidate.assignee))
    ) {
      problems.push(`${id}.assignee must be a GitHub login.`);
    }
    if (
      candidate.status !== undefined &&
      !['todo', 'in_progress', 'blocked', 'complete'].includes(candidate.status)
    ) {
      problems.push(`${id}.status is not a supported source status.`);
    }
    const expectedEvidence = `docs/roadmap/evidence/${id}.md`;
    const availableEvidence = [
      ...(documents.has(expectedEvidence) ? [expectedEvidence] : []),
      ...linkedEvidenceForTask(roadmap, id, documents),
    ];
    if (candidate.evidence !== undefined) {
      if (!documents.has(candidate.evidence) || !availableEvidence.includes(candidate.evidence)) {
        problems.push(
          `${id}.evidence must reference an existing evidence file linked to this task.`
        );
      }
    } else if (availableEvidence.length > 0) {
      problems.push(`${id}.evidence must reference an existing evidence file linked to this task.`);
    }
    tasks.push(/** @type {RoadmapTask} */ (candidate));
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (!Array.isArray(task.dependsOn)) continue;
    for (const dependency of task.dependsOn) {
      if (!taskById.has(dependency))
        problems.push(`${task.id} depends on missing task ${dependency}.`);
      if (dependency === task.id) problems.push(`${task.id} cannot depend on itself.`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      problems.push(`Dependency cycle includes ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const dependencies = taskById.get(id)?.dependsOn;
    if (!Array.isArray(dependencies)) return;
    for (const dependency of dependencies) {
      if (taskById.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of taskById.keys()) visit(id);

  const roadmapEntries = new Map();
  for (const [index, line] of roadmap.split(/\r?\n/u).entries()) {
    const match = new RegExp(`^\\s*-\\s*\\[([ xX])\\]\\s+(${taskIdSource})\\b`, 'u').exec(line);
    if (!match) continue;
    const [, checked, id] = match;
    const existing = roadmapEntries.get(id) ?? [];
    existing.push({
      checked: checked.toLowerCase() === 'x',
      line: index + 1,
      evidenceLinks: evidenceLinksFromLine(line),
    });
    roadmapEntries.set(id, existing);
  }
  for (const task of tasks) {
    const entries = roadmapEntries.get(task.id) ?? [];
    if (entries.length !== 1) {
      problems.push(`${task.id} must appear exactly once as a master roadmap checkbox.`);
      continue;
    }
    const checked = entries[0].checked;
    if (checked) {
      const evidencePath = `docs/roadmap/evidence/${task.id}.md`;
      const linkedEvidence = entries[0].evidenceLinks.some(
        ({ label, filePath }) => evidenceLabelCoversTask(label, task.id) && documents.has(filePath)
      );
      if (!linkedEvidence && !documents.has(evidencePath)) {
        problems.push(
          `${task.id} is checked complete but has no linked evidence file for this task.`
        );
      }
      if (task.status !== undefined && task.status !== 'complete') {
        problems.push(`${task.id} is checked complete but tasks.json status is ${task.status}.`);
      }
    } else if (task.status === 'complete') {
      problems.push(`${task.id} status is complete but its master roadmap checkbox is open.`);
    }
  }
  for (const id of roadmapEntries.keys()) {
    if (!taskById.has(id))
      problems.push(`${id} appears in ROADMAP.md but is missing from tasks.json.`);
  }
  const openCards = [...roadmapEntries.entries()]
    .filter(([, entries]) => entries.some((entry) => !entry.checked))
    .map(([id]) => id);
  const proseCounts = [
    { label: '', pattern: /(\d+) kartu terbuka/gu, actual: openCards.length },
    {
      label: 'M-series',
      pattern: /(\d+) kartu M-series terbuka/gu,
      actual: openCards.filter((id) => id.startsWith('M')).length,
    },
    {
      label: 'K-series',
      pattern: /(\d+) kartu K-series terbuka/gu,
      actual: openCards.filter((id) => id.startsWith('K')).length,
    },
  ];
  for (const { label, pattern, actual } of proseCounts) {
    for (const match of roadmap.matchAll(pattern)) {
      if (Number(match[1]) === actual) continue;
      const scope = label === '' ? 'open' : `open ${label}`;
      problems.push(
        `ROADMAP.md prose claims ${match[1]} ${scope} cards but the checklist holds ${actual}.`
      );
    }
  }
  return [...new Set(problems)];
}

async function loadRepository() {
  const indexPath = path.join(repositoryRoot, 'docs/roadmap/tasks.json');
  const roadmapPath = path.join(repositoryRoot, 'ROADMAP.md');
  const indexSource = await readFile(indexPath, 'utf8');
  const duplicateKeys = findDuplicateJsonObjectKeys(indexSource);
  if (duplicateKeys.length > 0) {
    throw new Error(
      `tasks.json contains duplicate object keys: ${[...new Set(duplicateKeys)].join(', ')}`
    );
  }
  const index = JSON.parse(indexSource);
  const roadmap = await readFile(roadmapPath, 'utf8');
  /** @type {Map<string, string>} */
  const documents = new Map();
  const candidatePaths = new Set([
    ...index.tasks.flatMap((task) => [task.detailFile, task.evidence].filter(Boolean)),
    ...index.tasks.map((task) => `docs/roadmap/evidence/${task.id}.md`),
    ...[...roadmap.matchAll(/\[[^\]]+\]\((docs\/roadmap\/evidence\/[^)#]+\.md)\)/gu)].map(
      ([, relativePath]) => relativePath
    ),
  ]);
  for (const relativePath of candidatePaths) {
    if (typeof relativePath !== 'string' || !isSafeRoadmapPath(relativePath, 'docs/roadmap/'))
      continue;
    try {
      await access(path.join(repositoryRoot, relativePath));
      documents.set(relativePath, await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
    } catch {
      // The pure validator reports absent references with the owning task ID.
    }
  }
  return { index, roadmap, documents };
}

async function main() {
  try {
    const { index, roadmap, documents } = await loadRepository();
    const problems = validateRoadmapIndex(index, roadmap, documents);
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Validated schema, IDs, cards, evidence, dependencies and checkboxes for ${index.tasks.length} roadmap tasks.\n`
    );
  } catch (error) {
    process.stderr.write(`Unable to validate roadmap: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
