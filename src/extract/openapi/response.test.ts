import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { extractResponseSchema, extractOpenApiRoutes } from './parse.js';

const FASTAPI_FIXTURE = resolve(import.meta.dirname, '../../../fixtures/fastapi-app');

describe('extractResponseSchema', () => {
  it('prefers 200, then 201, then any 2xx, then default', () => {
    const s = (code: string) => ({ responses: { [code]: { content: { 'application/json': { schema: { type: 'string' as const } } } } } });
    expect(extractResponseSchema(s('200'))?.type).toBe('string');
    expect(extractResponseSchema(s('201'))?.type).toBe('string');
    expect(extractResponseSchema(s('204'))?.type).toBe('string');
    expect(extractResponseSchema(s('default'))?.type).toBe('string');
  });

  it('returns undefined when there is no 2xx JSON response schema', () => {
    expect(extractResponseSchema({ responses: { '200': { description: 'OK' } as never } })).toBeUndefined();
    expect(extractResponseSchema({})).toBeUndefined();
  });

  it('picks 200 over other codes', () => {
    const op = {
      responses: {
        '500': { content: { 'application/json': { schema: { type: 'object' as const } } } },
        '200': { content: { 'application/json': { schema: { type: 'array' as const } } } },
      },
    };
    expect(extractResponseSchema(op)?.type).toBe('array');
  });
});

describe('extractOpenApiRoutes — outputSchema population', () => {
  const tools = extractOpenApiRoutes(FASTAPI_FIXTURE);

  it('populates outputSchema for a GET returning an object', () => {
    const getUser = tools.find((t) => t.method === 'GET' && t.path === '/api/users/:user_id');
    expect(getUser?.outputSchema?.type).toBe('object');
    expect(getUser?.outputSchema?.properties?.email?.format).toBe('email');
  });

  it('populates outputSchema for a GET returning an array', () => {
    const listUsers = tools.find((t) => t.method === 'GET' && t.path === '/api/users');
    expect(listUsers?.outputSchema?.type).toBe('array');
    expect(listUsers?.outputSchema?.items?.type).toBe('object');
  });

  it('leaves outputSchema undefined when the response has no schema', () => {
    const del = tools.find((t) => t.method === 'DELETE');
    expect(del?.outputSchema).toBeUndefined();
  });
});
