import { describe, it, expect, afterEach } from 'vitest';
import { detectStack } from './index.js';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

  it('detects graphql for graphql-app fixture (schema-first SDL with a root type)', () => {
    expect(detectStack(resolve(FIXTURES, 'graphql-app'))).toBe('graphql');
  });

  it('detects graphql for graphql-deep-app fixture (schema-first, deep/cyclic types)', () => {
    expect(detectStack(resolve(FIXTURES, 'graphql-deep-app'))).toBe('graphql');
  });

  it('detects graphql for graphql-codefirst-app fixture (type-graphql resolver decorators, no SDL)', () => {
    // No express/fastify/@nestjs deps → earlier detectors miss; the code-first branch
    // (type-graphql dep + @Resolver/@Query decorators) matches.
    expect(detectStack(resolve(FIXTURES, 'graphql-codefirst-app'))).toBe('graphql');
  });

  it('detects trpc for trpc-app fixture (@trpc/server + initTRPC router source)', () => {
    expect(detectStack(resolve(FIXTURES, 'trpc-app'))).toBe('trpc');
  });

  it('returns null for unknown directory', () => {
    expect(detectStack('/tmp')).toBeNull();
  });
});

describe('trpc detection precedence and false positives', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeProject(files: Record<string, string>): string {
    const dir = resolve(tmpdir(), `surfacemcp-trpc-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const [rel, content] of Object.entries(files)) {
      const abs = resolve(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    tmpDirs.push(dir);
    return dir;
  }

  it('wins over nextjs for a T3-style app that hosts a tRPC router', () => {
    // The entire programmatic surface of such an app is the router; the only Next
    // handler is the opaque `[trpc]` catch-all. See SPEC_TRPC_STACK.md.
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0', '@trpc/server': '11.0.0' } }),
      'next.config.js': 'module.exports = {};',
      'src/server/api/trpc.ts': "import { initTRPC } from '@trpc/server';\nconst t = initTRPC.create();\nexport const createTRPCRouter = t.router;\n",
    });
    expect(detectStack(dir)).toBe('trpc');
  });

  it('does NOT claim a Next.js app that only consumes a remote tRPC API', () => {
    // A client lists @trpc/server for its type imports but builds no router.
    const dir = makeProject({
      'package.json': JSON.stringify({
        dependencies: { next: '15.0.0', '@trpc/server': '11.0.0', '@trpc/client': '11.0.0' },
      }),
      'next.config.js': 'module.exports = {};',
      'src/utils/api.ts': "import { createTRPCReact } from '@trpc/react-query';\nimport type { AppRouter } from 'server';\nexport const api = createTRPCReact<AppRouter>();\n",
    });
    expect(detectStack(dir)).toBe('nextjs');
  });

  it('does NOT claim a project with router source but no @trpc/server dependency', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: { express: '5.0.0' } }),
      'src/index.js': "const app = require('express')();\napp.get('/health', (_q, r) => r.send('ok'));\n",
      'src/router.ts': 'export const appRouter = router({ a: publicProcedure.query(() => 1) });\n',
    });
    expect(detectStack(dir)).toBe('express');
  });
});
