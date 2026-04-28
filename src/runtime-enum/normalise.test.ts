import { describe, it, expect } from 'vitest';
import { normaliseRoutePath } from './normalise.js';

describe('normaliseRoutePath', () => {
  it('passes through simple paths unchanged', () => {
    expect(normaliseRoutePath('/dashboard')).toBe('/dashboard');
    expect(normaliseRoutePath('/')).toBe('/');
  });

  it('converts TanStack $param to :param', () => {
    expect(normaliseRoutePath('/users/$userId')).toBe('/users/:userId');
    expect(normaliseRoutePath('/items/$id/edit')).toBe('/items/:id/edit');
  });

  it('converts TanStack $splat to *', () => {
    expect(normaliseRoutePath('/docs/$splat')).toBe('/docs/*');
  });

  it('strips trailing slash (not root)', () => {
    expect(normaliseRoutePath('/dashboard/')).toBe('/dashboard');
    expect(normaliseRoutePath('/')).toBe('/');
  });

  it('collapses leading double slashes', () => {
    expect(normaliseRoutePath('//dashboard')).toBe('/dashboard');
  });

  it('strips query string', () => {
    expect(normaliseRoutePath('/users?role=admin')).toBe('/users');
  });

  it('strips hash', () => {
    expect(normaliseRoutePath('/page#section')).toBe('/page');
  });

  it('handles empty string', () => {
    expect(normaliseRoutePath('')).toBe('/');
  });

  it('handles $param at root level', () => {
    expect(normaliseRoutePath('/$slug')).toBe('/:slug');
  });
});
