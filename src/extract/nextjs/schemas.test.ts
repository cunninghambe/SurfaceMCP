import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { extractManualValidationSchema, extractManualValidationSchemaFromFile } from './schemas.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

function makeSourceFile(code: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('route.ts', code);
}

describe('extractManualValidationSchema', () => {
  it('detects falsy guard then throw', () => {
    const sf = makeSourceFile(`
      import { NextRequest, NextResponse } from 'next/server';
      export async function POST(req: NextRequest) {
        const body = await req.json();
        if (!body.memo) throw new Error('memo required');
        return NextResponse.json({ ok: true });
      }
    `);
    const result = extractManualValidationSchema(sf, 'POST');
    expect(result.confidence).toBe('partial');
    expect(result.schema.required).toContain('memo');
  });

  it('detects typeof guard on number field', () => {
    const sf = makeSourceFile(`
      import { NextRequest, NextResponse } from 'next/server';
      export async function POST(req: NextRequest) {
        const body = await req.json();
        if (typeof body.amount !== 'number') return NextResponse.json({ error: 'bad' }, { status: 400 });
        return NextResponse.json({ ok: true });
      }
    `);
    const result = extractManualValidationSchema(sf, 'POST');
    expect(result.confidence).toBe('partial');
    expect(result.schema.required).toContain('amount');
    expect(result.schema.properties?.['amount']).toMatchObject({ type: 'number' });
  });

  it('handles combined falsy guard + typeof guard (acceptance scenario)', () => {
    const sf = makeSourceFile(`
      import { NextRequest, NextResponse } from 'next/server';
      export async function POST(req: NextRequest) {
        const body = await req.json();
        if (!body.memo) throw new Error('memo required');
        if (typeof body.amount !== 'number') return NextResponse.json({ error: 'bad' }, { status: 400 });
        return NextResponse.json({ ok: true });
      }
    `);
    const result = extractManualValidationSchema(sf, 'POST');
    expect(result.confidence).toBe('partial');
    expect(result.schema.required).toEqual(['amount', 'memo']);
    expect(result.schema.properties?.['memo']).toMatchObject({ type: 'string' });
    expect(result.schema.properties?.['amount']).toMatchObject({ type: 'number' });
  });

  it('detects length guard', () => {
    const sf = makeSourceFile(`
      import { NextRequest, NextResponse } from 'next/server';
      export async function POST(req: NextRequest) {
        const body = await req.json();
        if (!body.title || body.title.length === 0) throw new Error('title required');
        return NextResponse.json({ ok: true });
      }
    `);
    const result = extractManualValidationSchema(sf, 'POST');
    expect(result.confidence).toBe('partial');
    expect(result.schema.required).toContain('title');
  });

  it('detects destructure-then-check pattern', () => {
    const sf = makeSourceFile(`
      import { NextRequest, NextResponse } from 'next/server';
      export async function POST(req: NextRequest) {
        const body = await req.json();
        const { name, email } = body;
        if (!name) throw new Error('name required');
        if (!email) throw new Error('email required');
        return NextResponse.json({ ok: true });
      }
    `);
    const result = extractManualValidationSchema(sf, 'POST');
    expect(result.confidence).toBe('partial');
    expect(result.schema.required).toContain('name');
    expect(result.schema.required).toContain('email');
  });

  it('returns unknown when Zod .parse() is present (defer to extractZodSchema)', () => {
    const sf = makeSourceFile(`
      import { z } from 'zod';
      import { NextRequest, NextResponse } from 'next/server';
      const schema = z.object({ name: z.string() });
      export async function POST(req: NextRequest) {
        const body = await req.json();
        const parsed = schema.parse(body);
        return NextResponse.json(parsed);
      }
    `);
    const result = extractManualValidationSchema(sf, 'POST');
    expect(result.confidence).toBe('unknown');
  });

  it('returns unknown when no body validation is present', () => {
    const sf = makeSourceFile(`
      import { NextResponse } from 'next/server';
      export async function GET() {
        return NextResponse.json({ ok: true });
      }
    `);
    const result = extractManualValidationSchema(sf, 'GET');
    expect(result.confidence).toBe('unknown');
  });

  it('returns unknown when validation is in a helper function (known limitation)', () => {
    const sf = makeSourceFile(`
      import { NextRequest, NextResponse } from 'next/server';
      function validateBody(body: Record<string, unknown>) {
        if (!body.memo) throw new Error('memo required');
      }
      export async function POST(req: NextRequest) {
        const body = await req.json();
        validateBody(body);
        return NextResponse.json({ ok: true });
      }
    `);
    const result = extractManualValidationSchema(sf, 'POST');
    expect(result.confidence).toBe('unknown');
  });
});

describe('extractManualValidationSchemaFromFile', () => {
  it('returns partial confidence for a file with manual validation', async () => {
    const tmp = resolve(tmpdir(), `surface-schema-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const filePath = resolve(tmp, 'route.ts');
    writeFileSync(filePath, `
      import { NextRequest, NextResponse } from 'next/server';
      export async function POST(req: NextRequest) {
        const body = await req.json();
        if (!body.memo) throw new Error('memo required');
        return NextResponse.json({ ok: true });
      }
    `);

    try {
      const result = await extractManualValidationSchemaFromFile(filePath);
      expect(result.confidence).toBe('partial');
      expect(result.schema.required).toContain('memo');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('returns unknown confidence for a file with no validation', async () => {
    const tmp = resolve(tmpdir(), `surface-schema-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const filePath = resolve(tmp, 'route.ts');
    writeFileSync(filePath, `
      import { NextResponse } from 'next/server';
      export async function GET() {
        return NextResponse.json({ items: [] });
      }
    `);

    try {
      const result = await extractManualValidationSchemaFromFile(filePath);
      expect(result.confidence).toBe('unknown');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});
