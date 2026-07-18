import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod } from './schema-to-zod.js';
import type { JsonSchema2020 } from '../types.js';

describe('jsonSchemaToZod', () => {
  it('models an object with required + optional typed properties', () => {
    const zt = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
    });
    expect(zt.safeParse({ name: 'x', age: 3 }).success).toBe(true);
    expect(zt.safeParse({ age: 3 }).success).toBe(false); // name required
    expect(zt.safeParse({ name: 'x' }).success).toBe(true); // age optional
    expect(zt.safeParse({ name: 1 }).success).toBe(false); // wrong type
  });

  it('enforces string format + length + pattern', () => {
    const email = jsonSchemaToZod({ type: 'string', format: 'email' });
    expect(email.safeParse('a@b.com').success).toBe(true);
    expect(email.safeParse('nope').success).toBe(false);

    const len = jsonSchemaToZod({ type: 'string', minLength: 2, maxLength: 4 });
    expect(len.safeParse('ab').success).toBe(true);
    expect(len.safeParse('a').success).toBe(false);
    expect(len.safeParse('abcde').success).toBe(false);
  });

  it('enforces number constraints', () => {
    const n = jsonSchemaToZod({ type: 'integer', minimum: 1, maximum: 10, multipleOf: 2 });
    expect(n.safeParse(4).success).toBe(true);
    expect(n.safeParse(3).success).toBe(false); // not multiple of 2
    expect(n.safeParse(0).success).toBe(false); // below min
    expect(n.safeParse(2.5).success).toBe(false); // not integer
  });

  it('models enums', () => {
    const e = jsonSchemaToZod({ type: 'string', enum: ['a', 'b'] });
    expect(e.safeParse('a').success).toBe(true);
    expect(e.safeParse('c').success).toBe(false);
  });

  it('models arrays with item type and bounds', () => {
    const a = jsonSchemaToZod({ type: 'array', items: { type: 'number' }, minItems: 1 });
    expect(a.safeParse([1, 2]).success).toBe(true);
    expect(a.safeParse([]).success).toBe(false);
    expect(a.safeParse(['x']).success).toBe(false);
  });

  it('honors nullable via type union', () => {
    const s = jsonSchemaToZod({ type: ['string', 'null'] });
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse('x').success).toBe(true);
    expect(s.safeParse(3).success).toBe(false);
  });

  it('models anyOf as a union', () => {
    const u = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'number' }] } as JsonSchema2020);
    expect(u.safeParse('x').success).toBe(true);
    expect(u.safeParse(3).success).toBe(true);
    expect(u.safeParse(true).success).toBe(false);
  });

  it('rejects unknown props when additionalProperties:false', () => {
    const strict = jsonSchemaToZod({
      type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false,
    });
    expect(strict.safeParse({ a: 'x', b: 1 }).success).toBe(false);
    const loose = jsonSchemaToZod({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
    expect(loose.safeParse({ a: 'x', b: 1 }).success).toBe(true);
  });

  it('falls back to an open record for empty / untyped schemas', () => {
    const z1 = jsonSchemaToZod(undefined);
    expect(z1.safeParse({ anything: 1 }).success).toBe(true);
    const z2 = jsonSchemaToZod({} as JsonSchema2020);
    expect(z2.safeParse({ anything: 1 }).success).toBe(true);
  });
});
