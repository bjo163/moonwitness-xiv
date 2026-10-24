import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [siteDirectory] = process.argv.slice(2);
if (!siteDirectory || !fs.existsSync(siteDirectory)) {
  process.stderr.write('Usage: node scripts/check-docs-publication.mjs <built-site-directory>\n');
  process.exit(2);
}

const forbiddenNames = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'auth.json',
  'playwright/.auth',
  'test-results',
]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  /\bauthorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /postgres(?:ql)?:\/\/[^\s"']+:[^\s"'@]+@/i,
  /(?:password|secret|token)\s*[:=]\s*["'][^"']{12,}["']/i,
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*["']?[\w.+/=-]{20,}["']?/i,
];

function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(siteDirectory, filePath).replaceAll(path.sep, '/');
    if (
      forbiddenNames.has(entry.name) ||
      /(?:^|\/)(?:\.env(?:\..*)?|\.git|test-results|playwright\/\.auth)(?:\/|$)/i.test(relativePath)
    ) {
      throw new Error(`Forbidden publication path: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      scan(filePath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unexpected filesystem entry: ${relativePath}`);
    if (entry.name.endsWith('.map'))
      throw new Error(`Source maps are not allowed in public docs: ${relativePath}`);
    const contents = fs.readFileSync(filePath);
    let text;
    if (
      contents[0] === 0xff &&
      contents[1] === 0xfe &&
      contents[2] === 0x00 &&
      contents[3] === 0x00
    ) {
      text = decodeUtf32(contents, true, relativePath);
    } else if (
      contents[0] === 0x00 &&
      contents[1] === 0x00 &&
      contents[2] === 0xfe &&
      contents[3] === 0xff
    ) {
      text = decodeUtf32(contents, false, relativePath);
    } else if (contents[0] === 0xff && contents[1] === 0xfe) {
      text = contents.subarray(2).toString('utf16le');
    } else if (contents[0] === 0xfe && contents[1] === 0xff) {
      text = Buffer.from(contents.subarray(2)).swap16().toString('utf16le');
    } else {
      if (contents.includes(0)) continue;
      text = contents.toString('utf8');
    }
    for (const pattern of secretPatterns) {
      if (pattern.test(text))
        throw new Error(`Potential secret detected in public file: ${relativePath}`);
    }
  }
}

function decodeUtf32(contents, littleEndian, relativePath) {
  const payload = contents.subarray(4);
  if (payload.length % 4 !== 0)
    throw new Error(`Invalid BOM-marked UTF-32 public file: ${relativePath}`);

  let text = '';
  for (let offset = 0; offset < payload.length; offset += 4) {
    const codePoint = littleEndian ? payload.readUInt32LE(offset) : payload.readUInt32BE(offset);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
      throw new Error(`Invalid BOM-marked UTF-32 public file: ${relativePath}`);
    text += String.fromCodePoint(codePoint);
  }
  return text;
}

try {
  scan(siteDirectory);
  process.stdout.write(`Public documentation scan passed: ${siteDirectory}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
