import { describe, it, expect } from 'vitest';
import { toolId, pathToToolName, methodToSideEffect } from './common.js';

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
