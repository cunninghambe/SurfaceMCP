import { describe, it, expect } from 'vitest';
import { extractPathParams, substitutePathParams, withPathParams } from './path-params.js';

describe('extractPathParams', () => {
  it('parses :name (express / nextjs)', () => {
    expect(extractPathParams('/api/users/:id').map((p) => p.name)).toEqual(['id']);
  });

  it('parses {name} (openapi / fastapi)', () => {
    expect(extractPathParams('/users/{userId}/posts/{postId}').map((p) => p.name))
      .toEqual(['userId', 'postId']);
  });

  it('parses <converter:name> and <name> (django)', () => {
    expect(extractPathParams('/articles/<int:pk>/<slug>').map((p) => p.name))
      .toEqual(['pk', 'slug']);
  });

  it('returns [] when there are no params', () => {
    expect(extractPathParams('/api/health')).toEqual([]);
  });

  it('de-duplicates repeated names', () => {
    expect(extractPathParams('/a/:id/b/:id').map((p) => p.name)).toEqual(['id']);
  });
});

describe('substitutePathParams', () => {
  it('substitutes and URL-encodes values', () => {
    const r = substitutePathParams('/users/:id', { id: 'a b/c' });
    expect(r).toEqual({ ok: true, path: '/users/a%20b%2Fc', consumed: new Set(['id']) });
  });

  it('reports missing params', () => {
    const r = substitutePathParams('/users/{id}/posts/{postId}', { id: '1' });
    expect(r).toEqual({ ok: false, missing: ['postId'] });
  });

  it('treats null / empty as missing', () => {
    expect(substitutePathParams('/u/:id', { id: '' })).toEqual({ ok: false, missing: ['id'] });
    expect(substitutePathParams('/u/:id', { id: null })).toEqual({ ok: false, missing: ['id'] });
  });

  it('does not let :id clobber :idcard', () => {
    const r = substitutePathParams('/x/:id/y/:idcard', { id: '1', idcard: '2' });
    expect(r.ok && r.path).toBe('/x/1/y/2');
  });

  it('leaves a param-less path untouched', () => {
    const r = substitutePathParams('/health', { foo: 'bar' });
    expect(r).toEqual({ ok: true, path: '/health', consumed: new Set() });
  });
});

describe('withPathParams', () => {
  it('adds path params as required string props', () => {
    const s = withPathParams({ type: 'object', properties: {}, required: [] }, extractPathParams('/u/:id'));
    expect(s.properties?.id?.type).toBe('string');
    expect(s.required).toContain('id');
  });

  it('preserves a richer existing property definition', () => {
    const existing = { type: 'object' as const, properties: { id: { type: 'integer' } }, required: [] };
    const s = withPathParams(existing, extractPathParams('/u/:id'));
    expect(s.properties?.id?.type).toBe('integer'); // not overwritten
    expect(s.required).toContain('id');
  });

  it('is a no-op with no params', () => {
    const s = { type: 'object' as const, properties: {} };
    expect(withPathParams(s, [])).toBe(s);
  });
});
