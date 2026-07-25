import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeCall } from './call.js';
import type { ToolMeta } from '../types.js';
import type { RoleMutex } from '../auth/role-mutex.js';

// A throwaway HTTP server that records the request line + body of the last call.
let server: http.Server;
let baseUrl: string;
let last: { method?: string; url?: string; body?: string };

beforeAll(async () => {
  last = {};
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      last = { method: req.method, url: req.url, body: Buffer.concat(chunks).toString() };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function tool(method: string, path: string): ToolMeta {
  return {
    name: 't', bareName: 't', surface: 's', toolId: 'deadbeef', method, path,
    inputSchema: { type: 'object' }, inputSchemaConfidence: 'unknown',
    sideEffectClass: method === 'GET' ? 'safe' : 'mutating',
    sourceFile: 'x', sourceLine: 1, isServerAction: false,
  };
}

// Minimal RoleMutex stub: an anonymous session, no auth.
const roleMutex = {
  ensureSession: async () => ({}),
  refresh: async () => ({}),
  roles: [{ name: 'anonymous', credentials: {} }],
} as unknown as RoleMutex;

function call(t: ToolMeta, input: Record<string, unknown>) {
  return executeCall({
    tool: t, role: 'anonymous', input, baseUrl, projectName: 'test',
    auth: { kind: 'none' }, roleMutex, revision: 1, currentRevision: 1,
  });
}

describe('executeCall path-param substitution', () => {
  it('substitutes a GET path param and sends the rest as query', async () => {
    const r = await call(tool('GET', '/users/:id'), { id: '42', q: 'hello' });
    expect(r.ok).toBe(true);
    expect(last.method).toBe('GET');
    expect(last.url).toBe('/users/42?q=hello');
  });

  it('substitutes a POST path param and omits it from the body', async () => {
    const r = await call(tool('POST', '/users/{id}/posts'), { id: '7', title: 'a' });
    expect(r.ok).toBe(true);
    expect(last.url).toBe('/users/7/posts');
    expect(JSON.parse(last.body ?? '{}')).toEqual({ title: 'a' });
  });

  it('returns missing_path_param without issuing a request', async () => {
    last = {};
    const r = await call(tool('GET', '/users/:id'), { q: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('missing_path_param');
    expect(last.url).toBeUndefined(); // server never hit
  });

  it('JSON-encodes object-valued query params instead of [object Object]', async () => {
    await call(tool('GET', '/search'), { filter: { a: 1 } });
    expect(last.url).toBe(`/search?filter=${encodeURIComponent('{"a":1}')}`);
  });
});

describe('executeCall rails', () => {
  it('readOnly refuses a mutating tool without issuing a request', async () => {
    last = {};
    const r = await executeCall({
      tool: tool('POST', '/users'), role: 'anonymous', input: { a: 1 }, baseUrl,
      projectName: 'test', auth: { kind: 'none' }, roleMutex, revision: 1,
      currentRevision: 1, readOnly: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('read_only_blocked');
    expect(last.url).toBeUndefined(); // server never hit
  });

  it('readOnly still permits a safe tool', async () => {
    const r = await executeCall({
      tool: tool('GET', '/users'), role: 'anonymous', input: {}, baseUrl,
      projectName: 'test', auth: { kind: 'none' }, roleMutex, revision: 1,
      currentRevision: 1, readOnly: true,
    });
    expect(r.ok).toBe(true);
    expect(last.method).toBe('GET');
  });

  it('dryRun returns the resolved request and sends nothing', async () => {
    last = {};
    const r = await executeCall({
      tool: tool('POST', '/users/:id/posts'), role: 'anonymous',
      input: { id: '7', title: 'hello' }, baseUrl,
      projectName: 'test', auth: { kind: 'none' }, roleMutex, revision: 1,
      currentRevision: 1, dryRun: true,
    });
    expect(r.ok).toBe(true);
    expect(last.url).toBeUndefined(); // nothing sent
    expect(r.dryRun?.method).toBe('POST');
    expect(r.dryRun?.url).toBe(`${baseUrl}/users/7/posts`); // path param substituted
    expect(JSON.parse(r.dryRun?.body ?? '{}')).toEqual({ title: 'hello' }); // path param not duplicated
  });

  it('dryRun masks credential headers', async () => {
    const r = await executeCall({
      tool: tool('GET', '/x'), role: 'anonymous', input: {}, baseUrl,
      projectName: 'test', auth: { kind: 'none' }, roleMutex, revision: 1,
      currentRevision: 1, dryRun: true, extraCookie: 'session=supersecret',
    });
    expect(JSON.stringify(r.dryRun)).not.toContain('supersecret');
    expect(r.dryRun?.headers.Cookie).toBe('<redacted>');
  });
});
