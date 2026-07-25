import { describe, it, expect } from 'vitest';
import { Project, SyntaxKind } from 'ts-morph';
import {
  buildTypeIndex,
  genericArgument,
  isInformativeSchema,
  schemaForTypeText,
  schemaForValueExpression,
  unwrapAsyncType,
} from './ts-type-schema.js';

/** Build an in-memory project from one file and index it. */
function ctxFor(code: string, includeShapes = true) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('a.ts', code);
  return { ctx: buildTypeIndex(project, { includeShapes }), sf };
}

describe('type-text helpers', () => {
  it('peels async wrappers off a return type', () => {
    expect(unwrapAsyncType('Promise<ItemDto>')).toBe('ItemDto');
    expect(unwrapAsyncType('Promise<ItemDto[]>')).toBe('ItemDto[]');
    expect(unwrapAsyncType('Promise<Awaited<ItemDto>>')).toBe('ItemDto');
    expect(unwrapAsyncType('ItemDto[]')).toBe('ItemDto[]');
    expect(unwrapAsyncType(undefined)).toBeUndefined();
  });

  it('reads the first type argument of a recognized generic wrapper', () => {
    expect(genericArgument('Response<Body>', ['Response'])).toBe('Body');
    // Express: `Response<ResBody, Locals>` — only the body matters.
    expect(genericArgument('Response<Body, Locals>', ['Response'])).toBe('Body');
    // A dotted qualifier still resolves by its bare name.
    expect(genericArgument('express.Response<Body>', ['Response'])).toBe('Body');
    // Nested generics are not split on their inner comma.
    expect(genericArgument('NextResponse<Map<string, number>>', ['NextResponse'])).toBe(
      'Map<string, number>'
    );
    expect(genericArgument('Response<Body>', ['NextResponse'])).toBeNull();
    expect(genericArgument('Response', ['Response'])).toBeNull();
  });

  it('rejects schemas that carry no information', () => {
    expect(isInformativeSchema({})).toBe(false);
    expect(isInformativeSchema({ type: 'object' })).toBe(false);
    expect(isInformativeSchema(undefined)).toBe(false);
    expect(isInformativeSchema({ type: 'object', properties: { a: {} } })).toBe(true);
    expect(isInformativeSchema({ type: 'array' })).toBe(true);
    expect(isInformativeSchema({ type: 'string' })).toBe(true);
    expect(isInformativeSchema({ enum: ['a'] })).toBe(true);
  });
});

describe('schemaForTypeText', () => {
  it('expands an interface, marking `?` members optional', () => {
    const { ctx } = ctxFor(`
      export interface Item { id: string; count: number; note?: string }
    `);
    expect(schemaForTypeText('Item', ctx)).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        count: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['id', 'count'],
    });
  });

  it('wraps array types and expands their element type', () => {
    const { ctx } = ctxFor(`export interface Item { id: string }`);
    expect(schemaForTypeText('Item[]', ctx)).toEqual({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
    expect(schemaForTypeText('Array<Item>', ctx)).toEqual(schemaForTypeText('Item[]', ctx));
  });

  it('resolves a type alias to an object literal and to another type', () => {
    const { ctx } = ctxFor(`
      export type Item = { id: string };
      export type Items = Item[];
    `);
    expect(schemaForTypeText('Items', ctx)).toEqual({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
  });

  it('resolves a named enum to an enum schema', () => {
    const { ctx } = ctxFor(`
      export enum Status { Draft = 'draft', Live = 'live' }
      export interface Item { status: Status }
    `);
    expect(schemaForTypeText('Item', ctx).properties?.status).toEqual({
      type: 'string',
      enum: ['draft', 'live'],
    });
  });

  it('stops at a self-referential type instead of recursing forever', () => {
    const { ctx } = ctxFor(`
      export interface Node { id: string; parent: Node; children: Node[] }
    `);
    const schema = schemaForTypeText('Node', ctx);
    // The cycle guard degrades the back-references to an open object.
    expect(schema.properties?.parent).toEqual({ type: 'object' });
    expect(schema.properties?.children).toEqual({ type: 'array', items: { type: 'object' } });
  });

  it('truncates past the depth ceiling', () => {
    const { ctx } = ctxFor(`
      export interface L1 { next: L2 }
      export interface L2 { next: L3 }
      export interface L3 { next: L4 }
      export interface L4 { next: L5 }
      export interface L5 { next: L6 }
      export interface L6 { leaf: string }
    `);
    let node = schemaForTypeText('L1', ctx);
    let depth = 0;
    while (node.properties?.next && Object.keys(node.properties.next).length > 1) {
      node = node.properties.next;
      depth++;
      if (depth > 10) break;
    }
    expect(depth).toBeLessThanOrEqual(5);
    expect(node.properties?.next).toEqual({ type: 'object' });
  });

  it('leaves unresolvable types open rather than guessing', () => {
    const { ctx } = ctxFor(`export interface Item { id: string }`);
    expect(schemaForTypeText('SomeImportedType', ctx)).toEqual({});
  });

  it('ignores interfaces when includeShapes is off (the NestJS configuration)', () => {
    const { ctx } = ctxFor(`export interface Item { id: string }`, false);
    expect(schemaForTypeText('Item', ctx)).toEqual({});
  });
});

describe('schemaForValueExpression', () => {
  /** Schema of the first argument of the `send(...)` call in `code`. */
  function firstCallArg(code: string, includeShapes = true) {
    const { ctx, sf } = ctxFor(code, includeShapes);
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => c.getExpression().getText() === 'send')!;
    return { schema: schemaForValueExpression(call.getArguments()[0], ctx), ctx };
  }

  it('types an object literal by its keys, without claiming they are required', () => {
    const { schema } = firstCallArg(`send({ ok: true, name: 'x', count: 1, missing: null })`);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        name: { type: 'string' },
        count: { type: 'number' },
        missing: { type: 'null' },
      },
    });
    expect(schema.required).toBeUndefined();
  });

  it('types a uniform array literal and leaves a mixed one bare', () => {
    expect(firstCallArg(`send(['a', 'b'])`).schema).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(firstCallArg(`send([])`).schema).toEqual({ type: 'array' });
    expect(firstCallArg(`send(['a', 1])`).schema).toEqual({ type: 'array' });
  });

  it('marks an object open when it spreads a value it cannot see', () => {
    const { schema } = firstCallArg(`send({ id: 'x', ...rest })`);
    expect(schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: true,
    });
  });

  it('follows an identifier to a same-file type annotation', () => {
    const { schema } = firstCallArg(`
      interface Body { id: string }
      const body: Body = load();
      send(body);
    `);
    expect(schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
  });

  it('reports an unresolvable value as an open schema, keeping the key', () => {
    const { schema } = firstCallArg(`send({ result: compute() })`);
    expect(schema).toEqual({ type: 'object', properties: { result: {} } });
  });

  it('prefers an `as` assertion type over the literal', () => {
    const { schema } = firstCallArg(`
      interface Body { id: string }
      send({} as Body);
    `);
    expect(schema.properties?.id).toEqual({ type: 'string' });
  });
});
