import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { taskIdPattern, taskIdSource } from './task-ids.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function taskLines(markdown) {
  return new Map(
    markdown.split(/\r?\n/u).flatMap((line) => {
      const match = new RegExp(`^- \\[[ xX]\\] (${taskIdSource})\\b(.*)$`, 'u').exec(line);
      return match ? [[match[1], line]] : [];
    })
  );
}

function taskSections(markdown, taskIds) {
  const lines = markdown.split(/\r?\n/u);
  const sections = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^##\\s+(${taskIdSource})\\b`, 'u').exec(lines[index]);
    if (!match || !taskIds.has(match[1])) continue;
    const end = lines.findIndex((line, lineIndex) => lineIndex > index && /^##\s/u.test(line));
    sections.set(match[1], lines.slice(index, end < 0 ? lines.length : end).join('\n'));
  }
  return sections;
}

function changedMapKeys(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key));
}

/**
 * Select only current roadmap tasks whose source-controlled issue content changed.
 * @param {{ beforeRoadmap: string, afterRoadmap: string, beforeIndex: {tasks: Array<{id: string, detailFile: string, evidence?: string}>}, afterIndex: {tasks: Array<{id: string, detailFile: string, evidence?: string}>}, beforeDocuments: Map<string, string>, afterDocuments: Map<string, string> }} input
 * @returns {string[]}
 */
export function selectChangedTaskIds({
  beforeRoadmap,
  afterRoadmap,
  beforeIndex,
  afterIndex,
  beforeDocuments,
  afterDocuments,
}) {
  const afterTasks = new Map(afterIndex.tasks.map((task) => [task.id, task]));
  const beforeTasks = new Map(beforeIndex.tasks.map((task) => [task.id, task]));
  const changed = new Set(
    changedMapKeys(taskLines(beforeRoadmap), taskLines(afterRoadmap)).filter((id) =>
      afterTasks.has(id)
    )
  );

  const taskIdsBefore = new Map([...beforeTasks].map(([id, task]) => [id, JSON.stringify(task)]));
  const taskIdsAfter = new Map([...afterTasks].map(([id, task]) => [id, JSON.stringify(task)]));
  for (const id of changedMapKeys(taskIdsBefore, taskIdsAfter)) {
    if (!afterTasks.has(id))
      throw new Error(`Roadmap task ${id} was removed; automatic issue deletion is not supported.`);
    changed.add(id);
  }

  const taskIds = new Set(afterTasks.keys());
  const beforeCards = new Map();
  const afterCards = new Map();
  for (const task of beforeIndex.tasks) {
    const content = beforeDocuments.get(task.detailFile);
    if (content !== undefined) beforeCards.set(task.detailFile, content);
  }
  for (const task of afterIndex.tasks) {
    const content = afterDocuments.get(task.detailFile);
    if (content !== undefined) afterCards.set(task.detailFile, content);
  }
  for (const file of new Set([...beforeCards.keys(), ...afterCards.keys()])) {
    const before = taskSections(beforeCards.get(file) ?? '', taskIds);
    const after = taskSections(afterCards.get(file) ?? '', taskIds);
    for (const id of changedMapKeys(before, after)) if (afterTasks.has(id)) changed.add(id);
  }

  for (const task of afterIndex.tasks) {
    if (!task.evidence) continue;
    if (beforeDocuments.get(task.evidence) !== afterDocuments.get(task.evidence))
      changed.add(task.id);
  }

  return [...changed].sort((left, right) => left.localeCompare(right));
}

function gitText(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
}

function gitDocument(revision, file) {
  try {
    return gitText(['show', `${revision}:${file}`]);
  } catch {
    return undefined;
  }
}

function parseIndex(value, label) {
  const parsed = JSON.parse(value);
  if (!parsed || !Array.isArray(parsed.tasks))
    throw new Error(`${label} roadmap index is invalid.`);
  return parsed;
}

async function main() {
  const baseIndex = process.argv.indexOf('--base');
  const headIndex = process.argv.indexOf('--head');
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined;
  const head = headIndex >= 0 ? process.argv[headIndex + 1] : undefined;
  if (!base || !head || base.startsWith('--') || head.startsWith('--'))
    throw new Error('Usage: node changed-task-ids.mjs --base <sha> --head <sha>');
  if (!/^(?:[a-f0-9]{40}|0{40})$/u.test(base) || !/^[a-f0-9]{40}$/u.test(head))
    throw new Error('Roadmap change selection requires full lowercase Git SHAs.');
  if (/^0{40}$/u.test(base)) {
    process.stdout.write('');
    return;
  }

  const beforeIndex = parseIndex(gitText(['show', `${base}:docs/roadmap/tasks.json`]), 'Base');
  const afterIndex = parseIndex(
    await readFile(path.join(repositoryRoot, 'docs/roadmap/tasks.json'), 'utf8'),
    'Head'
  );
  const beforeRoadmap = gitText(['show', `${base}:ROADMAP.md`]);
  const afterRoadmap = await readFile(path.join(repositoryRoot, 'ROADMAP.md'), 'utf8');
  const files = new Set([
    ...beforeIndex.tasks.flatMap((task) => [task.detailFile, task.evidence].filter(Boolean)),
    ...afterIndex.tasks.flatMap((task) => [task.detailFile, task.evidence].filter(Boolean)),
  ]);
  const beforeDocuments = new Map();
  const afterDocuments = new Map();
  for (const file of files) {
    const before = gitDocument(base, file);
    if (before !== undefined) beforeDocuments.set(file, before);
    try {
      afterDocuments.set(file, await readFile(path.join(repositoryRoot, file), 'utf8'));
    } catch {
      // Missing evidence is validated by the roadmap gate; deleted task sources fail closed below.
    }
  }
  const ids = selectChangedTaskIds({
    beforeRoadmap,
    afterRoadmap,
    beforeIndex,
    afterIndex,
    beforeDocuments,
    afterDocuments,
  });
  if (ids.some((id) => !taskIdPattern.test(id)))
    throw new Error('Invalid task ID in changed roadmap selection.');
  process.stdout.write(ids.join(','));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
