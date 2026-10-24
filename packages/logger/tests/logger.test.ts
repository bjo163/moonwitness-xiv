import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../src/index.js';

describe('Centralized Logger (@moonwitness/logger)', () => {
  const testLogDir = path.resolve(process.cwd(), 'tmp-test-logs');
  const testLogFile = 'test-run.log';

  afterAll(() => {
    try {
      if (fs.existsSync(testLogDir)) {
        fs.rmSync(testLogDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('should initialize logger with default silent in test if configured', () => {
    const log = createLogger({ level: 'silent' });
    expect(log).toBeDefined();
    expect(log.level).toBe('silent');
  });

  it('should create logger writing to a destination file', async () => {
    const log = createLogger({
      name: 'test-logger',
      level: 'info',
      logDir: testLogDir,
      logFileName: testLogFile,
      enableFile: true,
      enableConsole: false,
    });

    log.info({ test: 123 }, 'Hello world log test');

    // Wait slightly for pino transport worker thread to flush
    await new Promise((r) => setTimeout(r, 200));

    const fullFilePath = path.join(testLogDir, testLogFile);
    expect(fs.existsSync(fullFilePath)).toBe(true);

    const content = fs.readFileSync(fullFilePath, 'utf-8');
    expect(content).toContain('Hello world log test');
    expect(content).toContain('"test":123');
  });

  it('redacts credentials in structured and nested log fields', async () => {
    const log = createLogger({
      name: 'secret-redaction',
      level: 'info',
      logDir: testLogDir,
      logFileName: 'redaction.log',
      enableFile: true,
      enableConsole: false,
    });

    log.error(
      {
        password: 'sentinel-password',
        user: { password: 'sentinel-nested-password' },
        refresh_token: 'sentinel-refresh-token',
        session: { refresh_token: 'sentinel-nested-refresh-token' },
        access_token: 'sentinel-access-token',
        req: { headers: { authorization: 'Bearer sentinel-authorization' } },
      },
      'credential redaction probe'
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    const content = fs.readFileSync(path.join(testLogDir, 'redaction.log'), 'utf8');
    for (const sentinel of [
      'sentinel-password',
      'sentinel-nested-password',
      'sentinel-refresh-token',
      'sentinel-nested-refresh-token',
      'sentinel-access-token',
      'sentinel-authorization',
    ]) {
      expect(content).not.toContain(sentinel);
    }
    expect(content).toContain('[redacted]');
  });

  it('does not log raw paths when no matched route template is available', async () => {
    const log = createLogger({
      name: 'request-url-redaction',
      level: 'info',
      logDir: testLogDir,
      logFileName: 'request-url-redaction.log',
      enableFile: true,
      enableConsole: false,
    });

    log.info(
      {
        req: {
          method: 'GET',
          url: '/api/base.user?search=private-canary&token=query-token#private-fragment',
          hostname: 'localhost',
          remoteAddress: '127.0.0.1',
          remotePort: 3000,
        },
      },
      'request URL privacy probe'
    );
    log.info(
      { req: { method: 'GET', url: 'https://example.test/admin?token=absolute-token#private' } },
      'absolute URL privacy probe'
    );
    log.info(
      { req: { method: 'GET', url: 'http://user:malformed-secret@[' } },
      'malformed URL privacy probe'
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    const content = fs.readFileSync(path.join(testLogDir, 'request-url-redaction.log'), 'utf8');
    expect(content.match(/\[unmatched\]/g)).toHaveLength(3);
    for (const sensitiveValue of [
      'private-canary',
      'query-token',
      'private-fragment',
      'absolute-token',
      'example.test',
      'malformed-secret',
    ]) {
      expect(content).not.toContain(sensitiveValue);
    }
  });
});
