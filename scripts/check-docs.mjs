import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/gu;

export function stripFencedCode(source) {
  return source.replace(/^ {0,3}(```+|~~~+)[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gmu, (fence) =>
    fence.replace(/[^\n]/gu, '')
  );
}

function stripInlineHtmlTags(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1] ?? '';
    const mayStartTag = character === '<' && /[A-Za-z!?/]/u.test(next);
    if (mayStartTag) {
      const tagEnd = value.indexOf('>', index + 1);
      if (tagEnd !== -1) {
        index = tagEnd;
        continue;
      }
    }
    result += character;
  }
  return result;
}

export function slugHeading(heading) {
  return stripInlineHtmlTags(
    heading.replace(/\s+#+\s*$/u, '').replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
  )
    .replace(/`([^`]*)`/gu, '$1')
    .toLocaleLowerCase('en')
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, '')
    .trim()
    .replace(/[\s_]+/gu, '-')
    .replace(/-+/gu, '-');
}

export function collectMarkdownAnchors(source) {
  const markdown = stripFencedCode(source);
  const anchors = new Set();
  const counts = new Map();
  for (const match of markdown.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = slugHeading(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of markdown.matchAll(/\b(?:id|name)=["']([^"']+)["']/giu)) {
    anchors.add(match[1]);
  }
  return anchors;
}

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

// A clean checkout only ever contains tracked files, so the local gate has to
// read the same file set; otherwise an untracked scratch document fails a check
// that hosted runs cannot reproduce.
function trackedMarkdownFiles(directory) {
  const topLevel = git(['-C', directory, 'rev-parse', '--show-toplevel'])?.trim();
  if (topLevel === undefined) return undefined;
  const scope = relative(topLevel, directory).replaceAll('\\', '/');
  const listing = git(['-C', topLevel, 'ls-files', '--cached', '-z', '--', scope || '.']);
  if (listing === undefined) return undefined;
  return listing
    .split('\0')
    .filter(
      (file) =>
        file.toLowerCase().endsWith('.md') &&
        !file.split('/').some((segment) => ignoredDirectories.has(segment))
    )
    .map((file) => join(topLevel, file))
    .filter((file) => existsSync(file));
}

export async function listMarkdownFiles(directory, files = []) {
  const tracked = trackedMarkdownFiles(directory);
  if (tracked) {
    files.push(...tracked);
    return files;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      await listMarkdownFiles(join(directory, entry.name), files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

export async function findBrokenMarkdownLinks(markdownFiles, repositoryRoot) {
  const failures = [];
  for (const file of markdownFiles) {
    const source = await readFile(file, 'utf8');
    const markdown = stripFencedCode(source);
    for (const match of markdown.matchAll(linkPattern)) {
      const rawTarget = match[1].replace(/^<|>$/gu, '');
      if (!rawTarget || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(rawTarget)) continue;
      const [rawPath = '', rawFragment = ''] = rawTarget.split('#', 2);
      const localPath = decodeURIComponent(rawPath.split('?')[0] ?? '');
      const fragment = decodeURIComponent(rawFragment);
      const targetPath = localPath ? resolve(dirname(file), localPath) : file;
      const targetRelativePath = relative(repositoryRoot, targetPath);
      const display = `${relative(repositoryRoot, file).replaceAll('\\', '/')}:${source.slice(0, match.index).split('\n').length}`;
      if (
        targetRelativePath === '..' ||
        targetRelativePath.startsWith('..\\') ||
        targetRelativePath.startsWith('../') ||
        isAbsolute(targetRelativePath)
      ) {
        failures.push(`${display}: target escapes repository ${rawTarget}`);
        continue;
      }
      let targetStat;
      try {
        targetStat = await stat(targetPath);
      } catch {
        failures.push(`${display}: missing target ${rawTarget}`);
        continue;
      }
      if (fragment && targetStat.isFile() && extname(targetPath).toLowerCase() === '.md') {
        const targetSource = targetPath === file ? source : await readFile(targetPath, 'utf8');
        if (!collectMarkdownAnchors(targetSource).has(fragment)) {
          failures.push(`${display}: missing anchor ${rawTarget}`);
        }
      }
    }
  }
  return failures;
}

export async function checkMarkdownLinks(repositoryRoot = root) {
  const markdownFiles = await listMarkdownFiles(repositoryRoot);
  const failures = await findBrokenMarkdownLinks(markdownFiles, repositoryRoot);
  if (failures.length) {
    throw new Error(
      `Found ${failures.length} broken local Markdown link(s):\n${failures.join('\n')}`
    );
  }
  return markdownFiles.length;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkMarkdownLinks()
    .then((count) =>
      process.stdout.write(
        `Checked ${count} Markdown files; all local links and anchors resolve.\n`
      )
    )
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Markdown link check failed'}\n`
      );
      process.exitCode = 1;
    });
}
