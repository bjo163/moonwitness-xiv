import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { argv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { compareAssetInventory, listInventoryMedia } from './asset-inventory.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'manifest.json'), 'utf8'));
const licenses = JSON.parse(await readFile(resolve(packageRoot, 'licenses.json'), 'utf8'));
const allowedTags = new Set([
  'svg',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'g',
  'text',
  'defs',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
  'mask',
  'clipPath',
  'use',
]);

function assetSlug(filePath) {
  return filePath
    .replace(/\.svg$/u, '')
    .replace(/[^a-zA-Z\d]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

function findTagEnd(svg, start) {
  let quote = null;
  for (let index = start + 1; index < svg.length; index += 1) {
    const character = svg[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new Error('Unclosed XML tag');
}

function parseAttributes(source, filePath) {
  const attributes = new Map();
  const pattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/gy;
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? '')) index += 1;
    if (index >= source.length) break;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match)
      throw new Error(
        `${filePath}: malformed XML attribute near ${source.slice(index, index + 24)}`
      );
    const [, name, , doubleQuoted, singleQuoted] = match;
    if (attributes.has(name)) throw new Error(`${filePath}: duplicate ${name} attribute`);
    attributes.set(name, doubleQuoted ?? singleQuoted ?? '');
    index = pattern.lastIndex;
  }
  return attributes;
}

export function validateSvg(source, filePath) {
  if (/<!DOCTYPE|<!ENTITY|<\?xml/iu.test(source)) {
    throw new Error(`${filePath}: document declarations and entities are not allowed`);
  }

  const stack = [];
  const ids = new Set();
  const references = [];
  let rootAttributes = null;
  let rootClosed = false;
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) {
      const text = source.slice(cursor);
      if (text.includes('<') || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/iu.test(text)) {
        throw new Error(`${filePath}: invalid XML text or entity`);
      }
      break;
    }
    const text = source.slice(cursor, open);
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/iu.test(text)) {
      throw new Error(`${filePath}: invalid XML entity`);
    }
    const close = findTagEnd(source, open);
    const body = source.slice(open + 1, close);
    if (body.startsWith('!--') || body.startsWith('!') || body.startsWith('?')) {
      throw new Error(
        `${filePath}: comments, declarations, and processing instructions are not allowed in exported SVG`
      );
    }

    const closing = body.startsWith('/');
    const selfClosing = body.endsWith('/');
    const normalized = body.replace(/^\//u, '').replace(/\/$/u, '').trim();
    const nameMatch = normalized.match(/^([a-zA-Z][\w-]*)/u);
    if (!nameMatch) throw new Error(`${filePath}: invalid XML tag`);
    const name = nameMatch[1];
    if (!allowedTags.has(name)) throw new Error(`${filePath}: disallowed SVG element <${name}>`);

    if (closing) {
      if (normalized !== name || stack.at(-1) !== name) {
        throw new Error(`${filePath}: invalid closing tag </${name}>`);
      }
      stack.pop();
      if (name === 'svg') rootClosed = true;
      cursor = close + 1;
      continue;
    }

    if (rootClosed || (stack.length === 0 && name !== 'svg')) {
      throw new Error(`${filePath}: SVG must have exactly one svg root`);
    }
    const attributeText = normalized.slice(name.length);
    const attributes = parseAttributes(attributeText, filePath);
    for (const [attribute, value] of attributes) {
      if (/^on/i.test(attribute) || attribute.toLowerCase() === 'style') {
        throw new Error(
          `${filePath}: executable or inline style attribute ${attribute} is not allowed`
        );
      }
      if (['href', 'xlink:href', 'src'].includes(attribute.toLowerCase())) {
        if (!/^#[\w.-]+$/u.test(value))
          throw new Error(`${filePath}: only local fragment references are allowed`);
        references.push(value.slice(1));
      }
      for (const match of value.matchAll(/url\(\s*['"]?(.*?)['"]?\s*\)/giu)) {
        if (!match[1].startsWith('#'))
          throw new Error(`${filePath}: external SVG URL is not allowed`);
        references.push(match[1].slice(1));
      }
      if (attribute.toLowerCase() === 'id') {
        const prefix = `mw-${assetSlug(filePath)}-`;
        if (!value.startsWith(prefix))
          throw new Error(`${filePath}: id must use the ${prefix} prefix`);
        if (ids.has(value)) throw new Error(`${filePath}: duplicate id ${value}`);
        ids.add(value);
      }
      if (attribute === 'aria-labelledby' || attribute === 'aria-describedby') {
        references.push(...value.split(/\s+/u));
      }
    }

    if (stack.length === 0) {
      rootAttributes = attributes;
      if (attributes.get('xmlns') !== 'http://www.w3.org/2000/svg') {
        throw new Error(`${filePath}: SVG namespace is required`);
      }
    }
    if (!selfClosing) stack.push(name);
    else if (name === 'svg') rootClosed = true;
    cursor = close + 1;
  }

  if (stack.length > 0 || !rootClosed || rootAttributes?.get('viewBox') === undefined) {
    throw new Error(`${filePath}: incomplete SVG document or missing viewBox`);
  }
  if (rootAttributes.get('role') !== 'img' || !rootAttributes.has('aria-label')) {
    throw new Error(`${filePath}: exported SVG root needs an accessible image label`);
  }
  if (!/<title(?:\s[^>]*)?>.+?<\/title>/u.test(source)) {
    throw new Error(`${filePath}: exported SVG needs a non-empty title`);
  }
  for (const reference of references) {
    if (!ids.has(reference))
      throw new Error(`${filePath}: unresolved local reference #${reference}`);
  }
  return {
    ids,
    viewBox: rootAttributes.get('viewBox'),
    width: rootAttributes.get('width'),
    height: rootAttributes.get('height'),
  };
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  const inventoryDirectories = ['brand', 'fonts', 'icons', 'illustrations', 'sounds', 'source'];
  const packageFiles = await listInventoryMedia(packageRoot, inventoryDirectories);
  const inventoryDiff = compareAssetInventory(
    manifest.assets.map(({ path }) => path),
    packageFiles
  );
  if (inventoryDiff.unlistedFiles.length || inventoryDiff.missingFiles.length) {
    const details = [
      ...inventoryDiff.unlistedFiles.map(
        (path) => `- Unlisted asset file: ${path}. Add it to manifest.json and record provenance.`
      ),
      ...inventoryDiff.missingFiles.map((path) => `- Manifest asset file is missing: ${path}.`),
    ];
    throw new Error(`Asset inventory mismatch:\n${details.join('\n')}`);
  }

  const globalIds = new Set();
  let validatedSvgCount = 0;
  const seenAssets = new Set();
  for (const asset of manifest.assets) {
    if (
      isAbsolute(asset.path) ||
      asset.path.includes('\\') ||
      asset.path.split('/').includes('..')
    ) {
      throw new Error(`Manifest path must stay inside the package: ${asset.path}`);
    }
    if (seenAssets.has(asset.path)) throw new Error(`Duplicate manifest asset path: ${asset.path}`);
    seenAssets.add(asset.path);
    const normalizedPath = asset.path.replaceAll('/', sep);
    const fullPath = resolve(packageRoot, normalizedPath);
    const file = await stat(fullPath);
    if (!file.isFile()) throw new Error(`Manifest asset is not a file: ${asset.path}`);
    if (asset.kind === 'sound') {
      const provenance = licenses.soundEffects?.find((item) => item.path === asset.path);
      if (
        !provenance ||
        provenance.license !== asset.license ||
        !provenance.source ||
        !asset.source
      ) {
        throw new Error(
          `${asset.path}: sound effect must have matching manifest/license provenance`
        );
      }
      if (
        !['wav', 'mp3', 'ogg'].includes(asset.format) ||
        !(asset.durationSeconds > 0 && asset.durationSeconds <= 3)
      ) {
        throw new Error(
          `${asset.path}: sound must use a supported format and be 3 seconds or shorter`
        );
      }
      continue;
    }
    if (asset.format !== 'svg') continue;
    const source = await readFile(fullPath, 'utf8');
    const parsed = validateSvg(source, asset.path);
    if (parsed.viewBox !== `0 0 ${asset.width} ${asset.height}`) {
      throw new Error(`${asset.path}: viewBox does not match its manifest dimensions`);
    }
    if (parsed.width !== String(asset.width) || parsed.height !== String(asset.height)) {
      throw new Error(`${asset.path}: intrinsic dimensions do not match its manifest`);
    }
    for (const id of parsed.ids) {
      if (globalIds.has(id)) throw new Error(`Repeated inline-safe SVG ID across package: ${id}`);
      globalIds.add(id);
    }
    validatedSvgCount += 1;
  }

  stdout.write(`Validated ${validatedSvgCount} self-contained SVG assets.\n`);
}
