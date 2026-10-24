import { describe, expect, it } from 'vitest';
import { formatStartupFailure, startupErrorContext } from '../src/startup-diagnostics.js';

describe('startup diagnostics', () => {
  it('emits structured, allowlisted database error context', () => {
    const error = Object.assign(new Error('driver message with SQL bindings'), {
      code: '23505',
      table: 'base_user',
      constraint: 'base_user_login_key',
      password: 'must-not-be-logged',
    });

    expect(startupErrorContext(error)).toEqual({
      name: 'Error',
      code: '23505',
      category: 'unique_violation',
      constraint: 'base_user_login_key',
      table: 'base_user',
    });
    expect(formatStartupFailure(error)).not.toContain('must-not-be-logged');
    expect(formatStartupFailure(error)).not.toContain('SQL bindings');
  });

  it('redacts connection strings and secret-like assignments from unknown errors', () => {
    const error = new Error(
      'failed postgresql://postgres:top-secret@db.invalid/app JWT_SECRET=hidden authorization=Bearer-token'
    );

    const diagnostic = JSON.parse(formatStartupFailure(error)) as {
      event: string;
      context: Record<string, string>;
    };

    expect(diagnostic).toEqual({
      event: 'api_startup_failure',
      context: {
        name: 'Error',
        message: 'failed [redacted-url] JWT_SECRET=[redacted] authorization=[redacted]',
      },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/top-secret|hidden|Bearer-token/iu);
  });
});
