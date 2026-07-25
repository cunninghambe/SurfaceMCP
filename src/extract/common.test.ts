import { describe, it, expect } from 'vitest';
import { toolId, pathToToolName, methodToSideEffect, pickSuccessResponseKey } from './common.js';

describe('toolId', () => {
  it('is a stable 12-char sha1 of METHOD:path', () => {
    expect(toolId('GET', '/api/users/:id')).toHaveLength(12);
    expect(toolId('GET', '/api/users/:id')).toBe(toolId('GET', '/api/users/:id'));
    expect(toolId('GET', '/a')).not.toBe(toolId('POST', '/a'));
  });
});

describe('pathToToolName', () => {
  // The character class is a superset; each stack's paths only carry its own
  // param syntax, so these all collapse to the same shape the old per-stack
  // implementations produced.
  it('handles every param syntax identically', () => {
    expect(pathToToolName('GET', '/users/:id')).toBe('get_users_id');       // express / nextjs
    expect(pathToToolName('GET', '/users/{id}')).toBe('get_users_id');      // openapi / fastapi
    expect(pathToToolName('GET', '/users/<int:pk>')).toBe('get_users_int_pk'); // django (raw)
  });

  it('lowercases the method and falls back to root', () => {
    expect(pathToToolName('POST', '/')).toBe('post_root');
  });

  it('collapses repeated separators', () => {
    expect(pathToToolName('GET', '/a/{id}/b')).toBe('get_a_id_b');
  });
});

describe('methodToSideEffect', () => {
  it('treats read methods as safe regardless of case', () => {
    for (const m of ['GET', 'get', 'HEAD', 'options']) expect(methodToSideEffect(m)).toBe('safe');
    for (const m of ['POST', 'put', 'DELETE', 'patch']) expect(methodToSideEffect(m)).toBe('mutating');
  });
});

describe('pickSuccessResponseKey', () => {
  it('prefers 200, then 201, then other 2xx, then a wildcard, then default', () => {
    expect(pickSuccessResponseKey(['500', '201', '200'])).toBe('200');
    expect(pickSuccessResponseKey(['400', '201'])).toBe('201');
    expect(pickSuccessResponseKey(['204', '2XX'])).toBe('204');
    expect(pickSuccessResponseKey(['2XX', 'default'])).toBe('2XX');
    expect(pickSuccessResponseKey(['default', '404'])).toBe('default');
    expect(pickSuccessResponseKey(['299'])).toBe('299');
  });

  it("matches case-insensitively so Fastify's '2xx' resolves, returning the key as written", () => {
    expect(pickSuccessResponseKey(['2xx'])).toBe('2xx');
    expect(pickSuccessResponseKey(['DEFAULT'])).toBe('DEFAULT');
  });

  it('returns undefined when nothing describes a success response', () => {
    expect(pickSuccessResponseKey([])).toBeUndefined();
    expect(pickSuccessResponseKey(['400', '404', '500'])).toBeUndefined();
  });
});
