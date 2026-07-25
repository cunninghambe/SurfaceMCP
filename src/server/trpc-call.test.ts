import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeCall } from './call.js';
import type { ToolMeta, TrpcToolDescriptor } from '../types.js';
import type { RoleMutex } from '../auth/role-mutex.js';

// A throwaway HTTP server that records the request line, headers and body of the
// last call, and replies with a canned tRPC-shaped response.
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
      res.end(JSON.stringify({ result: { data: { id: '42' } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function trpcTool(descriptor: TrpcToolDescriptor, path = '/api/trpc'): ToolMeta {
  const name = `${descriptor.procedureType}_${descriptor.procedurePath.replace(/\./g, '_')}`;
  return {
    name,
    bareName: name,
    surface: 's',
    toolId: 'deadbeef0002',
    method: descriptor.procedureType === 'query' ? 'GET' : 'POST',
    path,
    inputSchema: { type: 'object' },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: descriptor.procedureType === 'query' ? 'safe' : 'mutating',
    sourceFile: 'src/router.ts',
    sourceLine: 1,
    isServerAction: false,
    trpc: descriptor,
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

describe('executeCall — tRPC tools', () => {
  it('GETs <trpcPath>/<dotted.path>?input=<json> for a query', async () => {
    const r = await call(
      trpcTool({ procedureType: 'query', procedurePath: 'post.byId' }),
      { id: '42' }
    );
    expect(r.ok).toBe(true);
    expect(last.method).toBe('GET');
    const url = new URL(last.url!, baseUrl);
    expect(url.pathname).toBe('/api/trpc/post.byId');
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ id: '42' });
    expect(last.body).toBe('');
  });

  it('POSTs the raw input as the JSON body for a mutation', async () => {
    await call(
      trpcTool({ procedureType: 'mutation', procedurePath: 'post.create' }),
      { title: 'Hi', body: 'there' }
    );
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/api/trpc/post.create');
    expect(last.contentType).toContain('application/json');
    // The body is the procedure input verbatim — not wrapped in a batch envelope.
    expect(JSON.parse(last.body ?? '{}')).toEqual({ title: 'Hi', body: 'there' });
  });

  it('hits the bare procedure URL when there is no input', async () => {
    await call(trpcTool({ procedureType: 'query', procedurePath: 'health' }), {});
    expect(last.url).toBe('/api/trpc/health');
  });

  it('honours a custom mount path from the tool path', async () => {
    await call(trpcTool({ procedureType: 'query', procedurePath: 'health' }, '/trpc'), {});
    expect(last.url).toBe('/trpc/health');
  });

  it('does not fall through to the REST query-string encoding for a query', async () => {
    await call(
      trpcTool({ procedureType: 'query', procedurePath: 'search' }),
      { q: 'hello', limit: 10 }
    );
    const url = new URL(last.url!, baseUrl);
    // Inputs ride inside the single `input` parameter, never as loose query params.
    expect(url.searchParams.get('q')).toBeNull();
    expect(url.searchParams.get('limit')).toBeNull();
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ q: 'hello', limit: 10 });
  });

  it('leaves a plain REST tool untouched (the branch is guarded on tool.trpc)', async () => {
    const rest: ToolMeta = {
      name: 'get_items',
      bareName: 'get_items',
      surface: 's',
      toolId: 'deadbeef0003',
      method: 'GET',
      path: '/api/items',
      inputSchema: { type: 'object' },
      inputSchemaConfidence: 'unknown',
      sideEffectClass: 'safe',
      sourceFile: 'src/items.ts',
      sourceLine: 1,
      isServerAction: false,
    };
    await call(rest, { limit: 5 });
    expect(last.url).toBe('/api/items?limit=5');
  });
});
