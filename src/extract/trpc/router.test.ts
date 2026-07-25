import { describe, it, expect, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractTrpcRouter, computeTrpcToolId, procedureToolName } from './router.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const root = resolve(FIXTURES, 'trpc-app');

type MustProcedure = {
  toolId: string;
  name: string;
  procedureType: string;
  procedurePath: string;
  method: string;
  sideEffectClass: string;
  inputSchemaConfidence: string;
};

function loadProcedures(): MustProcedure[] {
  const path = resolve(root, 'MUST_DISCOVER.json');
  return (JSON.parse(readFileSync(path, 'utf-8')) as { procedures: MustProcedure[] }).procedures;
}

describe('trpc-app router extraction', () => {
  it('emits one tool per procedure with pinned procedure-keyed toolIds', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    const byId = new Map(tools.map((t) => [t.toolId, t]));
    for (const expected of loadProcedures()) {
      const t = byId.get(expected.toolId);
      expect(t, `missing trpc procedure toolId=${expected.toolId} (${expected.name})`).toBeDefined();
      expect(t!.name).toBe(expected.name);
      expect(t!.method).toBe(expected.method);
      expect(t!.path).toBe('/api/trpc');
      expect(t!.sideEffectClass).toBe(expected.sideEffectClass);
      expect(t!.inputSchemaConfidence).toBe(expected.inputSchemaConfidence);
      expect(t!.trpc?.procedureType).toBe(expected.procedureType);
      expect(t!.trpc?.procedurePath).toBe(expected.procedurePath);
    }
    // No extras beyond the must-discover set, and toolIds are unique.
    expect(tools).toHaveLength(loadProcedures().length);
    expect(new Set(tools.map((t) => t.toolId)).size).toBe(tools.length);
  });

  it('keys toolIds on sha1(trpc:<procedureType>:<dotted.path>), not on method:path', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    // Pinned values guard against any drift in the hashing formula.
    expect(tools.find((t) => t.name === 'query_post_byId')?.toolId).toBe('4d06191f73a6');
    expect(tools.find((t) => t.name === 'mutation_post_create')?.toolId).toBe('32441e8677ed');
    expect(computeTrpcToolId('query', 'post.byId')).toBe('4d06191f73a6');
    for (const t of tools) expect(t.toolId).toMatch(/^[0-9a-f]{12}$/);

    // Every query shares `GET /api/trpc` and every mutation `POST /api/trpc`, so a
    // method:path scheme would have collapsed them; the procedure-keyed one doesn't.
    const queries = tools.filter((t) => t.method === 'GET');
    expect(queries.length).toBeGreaterThan(1);
    expect(new Set(queries.map((t) => t.toolId)).size).toBe(queries.length);
  });

  it('names tools <procedureType>_<dotted path with underscores>', () => {
    expect(procedureToolName('query', 'post.byId')).toBe('query_post_byId');
    expect(procedureToolName('mutation', 'create')).toBe('mutation_create');
    const tools = extractTrpcRouter(root, '/api/trpc');
    for (const t of tools) expect(t.name).not.toContain('.');
  });

  it('maps query → GET/safe and mutation → POST/mutating', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    for (const t of tools) {
      if (t.trpc?.procedureType === 'query') {
        expect(t.method).toBe('GET');
        expect(t.sideEffectClass).toBe('safe');
      } else {
        expect(t.method).toBe('POST');
        expect(t.sideEffectClass).toBe('mutating');
      }
    }
  });

  it('flattens nested routers (inline and cross-file) into dotted procedure paths', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    const paths = tools.map((t) => t.trpc!.procedurePath).sort();
    expect(paths).toEqual([
      'health',
      'post.byId',
      'post.create',
      'post.list',
      'search',
      'user.byEmail',
    ]);
    // `post` is a sub-router declared in another file and referenced by name.
    expect(tools.find((t) => t.trpc?.procedurePath === 'post.create')?.sourceFile).toBe(
      'src/routers/post.ts'
    );
    // `user` is an inline nested router in the root router file.
    expect(tools.find((t) => t.trpc?.procedurePath === 'user.byEmail')?.sourceFile).toBe(
      'src/router.ts'
    );
  });

  it('skips subscriptions (out of scope — not a request/response call)', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    expect(tools.some((t) => t.trpc?.procedurePath === 'onPostAdded')).toBe(false);
    expect(tools.some((t) => t.name.includes('subscription'))).toBe(false);
  });

  it('threads a custom trpcPath into the tool path without changing toolIds', () => {
    const tools = extractTrpcRouter(root, '/trpc');
    expect(tools.every((t) => t.path === '/trpc')).toBe(true);
    // toolIds are procedure-keyed, so they must not change with the mount path.
    expect(tools.find((t) => t.trpc?.procedurePath === 'post.byId')?.toolId).toBe('4d06191f73a6');
  });

  it('resolves an inline z.object() .input() to an introspected JSON Schema', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    const byId = tools.find((t) => t.trpc?.procedurePath === 'post.byId')!;
    expect(byId.inputSchemaConfidence).toBe('introspected');
    expect(byId.inputSchema.properties?.id).toMatchObject({ type: 'string', format: 'uuid' });
    expect(byId.inputSchema.required).toEqual(['id']);
  });

  it('resolves a file-level zod schema identifier, with constraints and optionality', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    const create = tools.find((t) => t.trpc?.procedurePath === 'post.create')!;
    expect(create.inputSchemaConfidence).toBe('introspected');
    expect(create.inputSchema.properties?.title).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 120,
    });
    expect(create.inputSchema.properties?.published).toMatchObject({ type: 'boolean' });
    // `.optional()` keeps `published` out of required.
    expect(create.inputSchema.required).toEqual(['title', 'body']);
  });

  it('populates outputSchema from .output(...) and leaves it absent otherwise', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    const create = tools.find((t) => t.trpc?.procedurePath === 'post.create')!;
    expect(create.outputSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
    });
    // No .output() anywhere else in the fixture.
    for (const t of tools) {
      if (t.trpc?.procedurePath !== 'post.create') expect(t.outputSchema).toBeUndefined();
    }
  });

  it('treats a procedure with no .input() as taking no input (introspected, closed empty object)', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    const list = tools.find((t) => t.trpc?.procedurePath === 'post.list')!;
    expect(list.inputSchemaConfidence).toBe('introspected');
    expect(list.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('falls back to unknown confidence when the .input() schema cannot be resolved', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    // `search` references a schema imported from another module; the shared static
    // zod reader is file-scoped, so it does not resolve. Documented limit.
    const search = tools.find((t) => t.trpc?.procedurePath === 'search')!;
    expect(search.inputSchemaConfidence).toBe('unknown');
    expect(search.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('normalizes sourceFile to posix separators and records a real source line', () => {
    const tools = extractTrpcRouter(root, '/api/trpc');
    for (const t of tools) {
      expect(t.sourceFile.includes('\\')).toBe(false);
      expect(t.sourceFile.startsWith('src/')).toBe(true);
      expect(t.sourceLine).toBeGreaterThan(0);
      expect(t.isServerAction).toBe(false);
    }
  });

  it('returns [] for a project with no tRPC router', () => {
    expect(extractTrpcRouter(resolve(FIXTURES, 'fastify-app'), '/api/trpc')).toEqual([]);
  });
});

describe('root-router selection', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeProject(files: Record<string, string>): string {
    const dir = resolve(tmpdir(), `surfacemcp-trpc-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const [rel, content] of Object.entries(files)) {
      const abs = resolve(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    tmpDirs.push(dir);
    return dir;
  }

  it('prefers appRouter over any other unreferenced router', () => {
    const dir = makeProject({
      'a-other.ts': "export const otherRouter = router({ nope: publicProcedure.query(() => 1) });\n",
      'z-app.ts': "export const appRouter = router({ yes: publicProcedure.query(() => 1) });\n",
    });
    const tools = extractTrpcRouter(dir, '/api/trpc');
    expect(tools.map((t) => t.trpc!.procedurePath)).toEqual(['yes']);
  });

  it('skips a candidate that yields no procedures and falls through to the real router', () => {
    const dir = makeProject({
      // Sorts first, matches the router-call shape, but holds no procedures.
      'a-decoy.ts': "export const decoy = router({ mode: 'history', base: '/' });\n",
      'b-real.ts': "export const apiRouter = router({ ping: publicProcedure.query(() => 'pong') });\n",
    });
    const tools = extractTrpcRouter(dir, '/api/trpc');
    expect(tools.map((t) => t.trpc!.procedurePath)).toEqual(['ping']);
  });

  it('handles a router literal that is never bound to a variable', () => {
    const dir = makeProject({
      'server.ts':
        "createHTTPServer({ router: router({ hello: publicProcedure.query(() => 'hi') }) });\n",
    });
    const tools = extractTrpcRouter(dir, '/api/trpc');
    expect(tools.map((t) => t.trpc!.procedurePath)).toEqual(['hello']);
  });

  it('skips procedure keys that are not identifier-like (they would be interpolated into the URL)', () => {
    const dir = makeProject({
      'router.ts':
        "export const appRouter = router({ 'a/b?x': publicProcedure.query(() => 1), ok: publicProcedure.query(() => 1) });\n",
    });
    const tools = extractTrpcRouter(dir, '/api/trpc');
    expect(tools.map((t) => t.trpc!.procedurePath)).toEqual(['ok']);
  });
});
