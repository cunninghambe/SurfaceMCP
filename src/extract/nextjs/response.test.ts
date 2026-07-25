import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractNextjsRoutes } from './routes.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/** Write `code` at `relPath` inside a fresh temp project root. */
function scratch(relPath: string, code: string): string {
  const dir = resolve(
    tmpdir(),
    `surfacemcp-nextjs-response-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const file = resolve(dir, relPath);
  mkdirSync(resolve(file, '..'), { recursive: true });
  tmpDirs.push(dir);
  writeFileSync(file, code, 'utf-8');
  return dir;
}

describe('nextjs response typing — fixture (App Router)', () => {
  it('types each verb from its own NextResponse.json literal', async () => {
    const tools = await extractNextjsRoutes(resolve(FIXTURES, 'nextjs-app'));
    const byKey = new Map(tools.map((t) => [`${t.method} ${t.path}`, t]));

    const list = byKey.get('GET /api/users')!;
    expect(list.outputSchemaConfidence).toBe('inferred');
    expect(list.outputSchema).toEqual({
      type: 'object',
      properties: { users: { type: 'array' } },
    });

    // Same file, different verb — the POST handler has its own shape.
    const create = byKey.get('POST /api/users')!;
    expect(create.outputSchema).toEqual({ type: 'object', properties: { user: {} } });
  });

  it('leaves the pinned input schemas and toolIds untouched', async () => {
    const tools = await extractNextjsRoutes(resolve(FIXTURES, 'nextjs-app'));
    const create = tools.find((t) => t.method === 'POST' && t.path === '/api/users')!;
    expect(create.inputSchemaConfidence).toBe('introspected');
    expect(create.inputSchema.properties?.email).toBeDefined();
  });
});

describe('nextjs response typing — edge cases', () => {
  it('prefers a declared Promise<NextResponse<T>> return type', async () => {
    const dir = scratch(
      'app/api/items/route.ts',
      `
      import { NextResponse } from 'next/server';

      interface ItemsBody { items: string[]; total: number }

      export async function GET(): Promise<NextResponse<ItemsBody>> {
        return NextResponse.json({ items: [], total: 0 });
      }
      `
    );
    const tool = (await extractNextjsRoutes(dir))[0];
    expect(tool.outputSchemaConfidence).toBe('inferred');
    expect(tool.outputSchema).toEqual({
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' } }, total: { type: 'number' } },
      required: ['items', 'total'],
    });
  });

  it('reads the NextApiResponse<T> generic on a Pages Router handler', async () => {
    const dir = scratch(
      'pages/api/legacy.ts',
      `
      import type { NextApiRequest, NextApiResponse } from 'next';

      type LegacyBody = { ok: boolean; message?: string };

      export default function handler(req: NextApiRequest, res: NextApiResponse<LegacyBody>) {
        res.status(200).json({ ok: true });
      }
      `
    );
    const tools = await extractNextjsRoutes(dir);
    // Pages Router: one handler serves every verb, so both detected verbs share it.
    expect(tools.map((t) => t.method).sort()).toEqual(['GET', 'POST']);
    for (const tool of tools) {
      expect(tool.outputSchemaConfidence).toBe('inferred');
      expect(tool.outputSchema).toEqual({
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok'],
      });
    }
  });

  it('falls back to a Pages Router res.json literal when the generic is absent', async () => {
    const dir = scratch(
      'pages/api/plain.ts',
      `
      export default function handler(req, res) {
        res.status(200).json({ ok: true });
      }
      `
    );
    expect((await extractNextjsRoutes(dir))[0].outputSchema).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    });
  });

  it('emits nothing when a handler branches to different shapes', async () => {
    const dir = scratch(
      'app/api/branchy/route.ts',
      `
      import { NextResponse } from 'next/server';

      export async function GET(req: Request) {
        if (!req.url) return NextResponse.json({ error: 'bad' }, { status: 400 });
        return NextResponse.json({ items: [] });
      }
      `
    );
    expect((await extractNextjsRoutes(dir))[0].outputSchema).toBeUndefined();
  });

  it('reads the bare Response.json helper too', async () => {
    const dir = scratch(
      'app/api/web/route.ts',
      `
      export async function GET() {
        return Response.json({ ok: true });
      }
      `
    );
    expect((await extractNextjsRoutes(dir))[0].outputSchema).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    });
  });

  it('does not emit a schema for a route that returns a bare Response', async () => {
    const dir = scratch(
      'app/api/text/route.ts',
      `
      export async function GET() {
        return new Response('hello', { status: 200 });
      }
      `
    );
    expect((await extractNextjsRoutes(dir))[0].outputSchema).toBeUndefined();
  });
});
