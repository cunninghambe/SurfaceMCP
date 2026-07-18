import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse } from 'graphql';
import { executeCall } from './call.js';
import type { ToolMeta, GraphQLToolDescriptor } from '../types.js';
import type { RoleMutex } from '../auth/role-mutex.js';

// A throwaway HTTP server that records the request line, headers, and body of the
// last call, and replies with a canned GraphQL-shaped response.
let server: http.Server;
let baseUrl: string;
let last: { method?: string; url?: string; contentType?: string; body?: string };

beforeAll(async () => {
  last = {};
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      last = {
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString(),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { user: { id: '42', name: 'Ada' } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function graphqlTool(descriptor: GraphQLToolDescriptor): ToolMeta {
  return {
    name: `${descriptor.operationType}_${descriptor.field}`,
    bareName: `${descriptor.operationType}_${descriptor.field}`,
    surface: 's',
    toolId: 'deadbeef0001',
    method: 'POST',
    path: '/graphql',
    inputSchema: { type: 'object' },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: descriptor.operationType === 'query' ? 'safe' : 'mutating',
    sourceFile: 'schema.graphql',
    sourceLine: 1,
    isServerAction: false,
    graphql: descriptor,
  };
}

const roleMutex = {
  ensureSession: async () => ({}),
  refresh: async () => ({}),
  roles: [{ name: 'anonymous', credentials: {} }],
} as unknown as RoleMutex;

function call(t: ToolMeta, input: Record<string, unknown>) {
  return executeCall({
    tool: t,
    role: 'anonymous',
    input,
    baseUrl,
    projectName: 'test',
    auth: { kind: 'none' },
    roleMutex,
    revision: 1,
    currentRevision: 1,
  });
}

describe('executeCall — GraphQL tools', () => {
  it('POSTs a well-formed { query, variables } body to the graphql endpoint', async () => {
    const r = await call(
      graphqlTool({
        operationType: 'query',
        field: 'user',
        args: [{ name: 'id', gqlType: 'ID!' }],
        selection: 'id name email',
      }),
      { id: '42' },
    );
    expect(r.ok).toBe(true);
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/graphql');
    expect(last.contentType).toContain('application/json');

    const parsed = JSON.parse(last.body ?? '{}') as { query: string; variables: Record<string, unknown> };
    expect(parsed.variables).toEqual({ id: '42' });
    expect(parsed.query).toBe('query user($id: ID!) { user(id: $id) { id name email } }');
    // The query the server received is a valid GraphQL document.
    expect(() => parse(parsed.query)).not.toThrow();
  });

  it('sends a mutation body with the input object as variables', async () => {
    await call(
      graphqlTool({
        operationType: 'mutation',
        field: 'createUser',
        args: [{ name: 'input', gqlType: 'NewUserInput!' }],
        selection: 'id name',
      }),
      { input: { name: 'Ada', email: 'ada@x.dev' } },
    );
    const parsed = JSON.parse(last.body ?? '{}') as { query: string; variables: Record<string, unknown> };
    expect(parsed.variables).toEqual({ input: { name: 'Ada', email: 'ada@x.dev' } });
    expect(parsed.query).toContain('mutation createUser($input: NewUserInput!)');
    expect(() => parse(parsed.query)).not.toThrow();
  });

  it('does not turn the graphql input into a query string (body-encoded, not URL-encoded)', async () => {
    await call(
      graphqlTool({ operationType: 'query', field: 'users', args: [], selection: 'id' }),
      {},
    );
    // The endpoint path is hit verbatim; inputs never leak into the URL.
    expect(last.url).toBe('/graphql');
    expect(JSON.parse(last.body ?? '{}')).toEqual({
      query: 'query users { users { id } }',
      variables: {},
    });
  });
});
