import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractNestjsRoutes } from './routes.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(code: string): string {
  const dir = resolve(
    tmpdir(),
    `surfacemcp-nestjs-response-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  writeFileSync(resolve(dir, 'app.ts'), code, 'utf-8');
  return dir;
}

const ITEM_RESPONSE = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    price: { type: 'number' },
    category: { type: 'string' },
  },
  required: ['id', 'name', 'price'],
};

describe('nestjs response typing — fixture', () => {
  const tools = extractNestjsRoutes(resolve(FIXTURES, 'nestjs-app'));
  const byKey = new Map(tools.map((t) => [`${t.method} ${t.path}`, t]));

  it('derives an array response from an array return type', () => {
    const findAll = byKey.get('GET /items')!;
    expect(findAll.outputSchemaConfidence).toBe('inferred');
    expect(findAll.outputSchema).toEqual({ type: 'array', items: ITEM_RESPONSE });
  });

  it('unwraps Promise<...> and expands a nested response DTO', () => {
    const findOne = byKey.get('GET /items/:id')!;
    expect(findOne.outputSchemaConfidence).toBe('inferred');
    expect(findOne.outputSchema).toEqual({
      type: 'object',
      properties: { item: ITEM_RESPONSE, revision: { type: 'number' } },
      required: ['item', 'revision'],
    });
  });

  it('treats an @ApiResponse({ type }) declaration as introspected', () => {
    const create = byKey.get('POST /items')!;
    expect(create.outputSchemaConfidence).toBe('introspected');
    expect(create.outputSchema).toEqual(ITEM_RESPONSE);
  });

  it('emits nothing for handlers with neither a decorator nor a return type', () => {
    for (const key of ['GET /items/search', 'PUT /items/:id', 'DELETE /items/:id', 'GET /health']) {
      expect(byKey.get(key)!.outputSchema, key).toBeUndefined();
    }
  });

  it('leaves the pinned toolIds, names and input schemas unchanged', () => {
    expect(byKey.get('GET /items')!.toolId).toBe('df0a23d36435');
    expect(byKey.get('GET /items/:id')!.toolId).toBe('a23d986fb7da');
    expect(byKey.get('GET /health')!.toolId).toBe('389ff1e1c9e3');
    const create = byKey.get('POST /items')!;
    expect(create.inputSchemaConfidence).toBe('introspected');
    expect(create.inputSchema.required).toEqual(['name', 'price']);
  });
});

describe('nestjs response typing — edge cases', () => {
  it('honours the Swagger array shorthand `type: [Dto]`', () => {
    const dir = scratch(`
      import { Controller, Get } from '@nestjs/common';
      import { ApiOkResponse } from '@nestjs/swagger';

      export class ThingDto { id: string; }

      @Controller('things')
      export class ThingsController {
        @Get()
        @ApiOkResponse({ type: [ThingDto] })
        findAll() { return []; }
      }
    `);
    const tool = extractNestjsRoutes(dir)[0];
    expect(tool.outputSchemaConfidence).toBe('introspected');
    expect(tool.outputSchema).toEqual({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
  });

  it('honours `isArray: true` alongside `type`', () => {
    const dir = scratch(`
      import { Controller, Get } from '@nestjs/common';
      import { ApiResponse } from '@nestjs/swagger';

      export class ThingDto { id: string; }

      @Controller('things')
      export class ThingsController {
        @Get()
        @ApiResponse({ status: 200, type: ThingDto, isArray: true })
        findAll() { return []; }
      }
    `);
    expect(extractNestjsRoutes(dir)[0].outputSchema?.type).toBe('array');
  });

  it('ignores a non-2xx @ApiResponse and falls back to the return type', () => {
    const dir = scratch(`
      import { Controller, Get } from '@nestjs/common';
      import { ApiResponse } from '@nestjs/swagger';

      export class ErrorDto { message: string; }
      export class ThingDto { id: string; }

      @Controller('things')
      export class ThingsController {
        @Get()
        @ApiResponse({ status: 404, type: ErrorDto })
        findAll(): ThingDto { return { id: '' }; }
      }
    `);
    const tool = extractNestjsRoutes(dir)[0];
    expect(tool.outputSchemaConfidence).toBe('inferred');
    expect(tool.outputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
  });

  it('accepts a HttpStatus.OK symbolic status', () => {
    const dir = scratch(`
      import { Controller, Get, HttpStatus } from '@nestjs/common';
      import { ApiResponse } from '@nestjs/swagger';

      export class ThingDto { id: string; }

      @Controller('things')
      export class ThingsController {
        @Get()
        @ApiResponse({ status: HttpStatus.OK, type: ThingDto })
        findAll() { return []; }
      }
    `);
    expect(extractNestjsRoutes(dir)[0].outputSchemaConfidence).toBe('introspected');
  });

  it('emits nothing for a primitive-ish or unresolvable return type', () => {
    const dir = scratch(`
      import { Controller, Get } from '@nestjs/common';

      @Controller('things')
      export class ThingsController {
        @Get('a')
        a(): Promise<SomeImportedType> { return null as never; }
        @Get('b')
        b(): void {}
      }
    `);
    for (const tool of extractNestjsRoutes(dir)) {
      expect(tool.outputSchema, tool.path).toBeUndefined();
    }
  });

  it('applies one return type to both verbs produced by @All()', () => {
    const dir = scratch(`
      import { Controller, All } from '@nestjs/common';

      export class PingDto { pong: boolean; }

      @Controller()
      export class PingController {
        @All('ping')
        ping(): PingDto { return { pong: true }; }
      }
    `);
    const tools = extractNestjsRoutes(dir);
    expect(tools.map((t) => t.method).sort()).toEqual(['GET', 'POST']);
    for (const tool of tools) {
      expect(tool.outputSchema).toEqual({
        type: 'object',
        properties: { pong: { type: 'boolean' } },
        required: ['pong'],
      });
    }
  });
});
