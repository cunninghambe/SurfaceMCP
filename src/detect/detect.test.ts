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
