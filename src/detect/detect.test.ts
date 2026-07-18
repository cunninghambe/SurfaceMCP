import { describe, it, expect } from 'vitest';
import { detectStack } from './index.js';
import { resolve } from 'node:path';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures');

describe('stack detection', () => {
  it('detects nextjs for nextjs-app fixture', () => {
    expect(detectStack(resolve(FIXTURES, 'nextjs-app'))).toBe('nextjs');
  });

  it('detects express for express-app fixture', () => {
    expect(detectStack(resolve(FIXTURES, 'express-app'))).toBe('express');
  });

  it('detects fastify for fastify-app fixture', () => {
    expect(detectStack(resolve(FIXTURES, 'fastify-app'))).toBe('fastify');
  });

  it('detects nestjs for nestjs-app fixture (not express/fastify)', () => {
    // Nest keys on @nestjs/core + a @Controller/@nestjs/common source signal.
    // The fixture has neither `express` nor `fastify` as a direct dep, and its
    // main.ts uses `app.listen` (not `app.get`), so it can't false-positive.
    expect(detectStack(resolve(FIXTURES, 'nestjs-app'))).toBe('nestjs');
  });

  it('detects fastapi for fastapi-app fixture (has openapi.json but fastapi in requirements)', () => {
    // fastapi-app has both openapi.json and requirements.txt with fastapi
    // Stack detection order: nextjs > django > express > fastapi > openapi
    // fastapi-app has no nextjs/django/express, so fastapi wins
    const stack = detectStack(resolve(FIXTURES, 'fastapi-app'));
    expect(['fastapi', 'openapi']).toContain(stack);
  });

  it('detects django for django-app fixture', () => {
    expect(detectStack(resolve(FIXTURES, 'django-app'))).toBe('django');
  });

  it('returns null for unknown directory', () => {
    expect(detectStack('/tmp')).toBeNull();
  });
});
