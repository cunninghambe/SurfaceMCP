import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFastApiSchema } from './openapi-fetch.js';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchFastApiSchema', () => {
  it('success: returns routes from a live OpenAPI response', async () => {
    const miniSpec = {
      openapi: '3.1.0',
      paths: {
        '/api/items': {
          get: { operationId: 'list_items', responses: {} },
          post: { operationId: 'create_item', responses: {} },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(miniSpec),
    }));

    const tools = await fetchFastApiSchema('http://localhost:8000');
    expect(tools.length).toBe(2);
    expect(tools.find((t) => t.method === 'GET' && t.path === '/api/items')).toBeDefined();
    expect(tools.find((t) => t.method === 'POST' && t.path === '/api/items')).toBeDefined();
  });

  it('live-fail-with-static: falls back to static openapi.json when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const root = resolve(FIXTURES, 'fastapi-app');
    const tools = await fetchFastApiSchema('http://localhost:8000', root);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.find((t) => t.method === 'GET' && t.path === '/api/users')).toBeDefined();
  });

  it('live-fail-no-static: returns [] when fetch fails and root has no openapi.json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const emptyRoot = mkdtempSync(resolve(tmpdir(), 'surfacemcp-test-'));
    const tools = await fetchFastApiSchema('http://localhost:8000', emptyRoot);
    expect(tools).toEqual([]);
  });

  it('live-fail-no-root: returns [] when fetch fails and no root is provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const tools = await fetchFastApiSchema('http://localhost:8000');
    expect(tools).toEqual([]);
  });
});
