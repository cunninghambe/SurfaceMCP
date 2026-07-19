import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument, buildOpenApiResult } from './openapi.js';
import type { ToolMeta } from '../types.js';

function tool(partial: Partial<ToolMeta> & Pick<ToolMeta, 'method' | 'path'>): ToolMeta {
  return {
    name: 't', bareName: 't', surface: 's', toolId: 'abc123',
    inputSchema: { type: 'object' }, inputSchemaConfidence: 'unknown',
    sideEffectClass: 'safe', sourceFile: 'x', sourceLine: 1, isServerAction: false,
    ...partial,
  };
}

describe('buildOpenApiDocument', () => {
  it('emits an OpenAPI 3.1 doc with servers and info', () => {
    const doc = buildOpenApiDocument([], { title: 'API', version: '1.0.0', baseUrl: 'http://x' });
    expect(doc.openapi).toBe('3.1.0');
    expect((doc.info as { title: string }).title).toBe('API');
    expect(doc.servers).toEqual([{ url: 'http://x' }]);
  });

  it('templates :id path params to {id} and emits path parameters', () => {
    const doc = buildOpenApiDocument(
      [tool({ method: 'GET', path: '/users/:id', name: 'get_users_id', inputSchema: { type: 'object', properties: { id: { type: 'integer' } } } })],
      { title: 'API', version: '1.0.0' },
    );
    const paths = doc.paths as Record<string, Record<string, { parameters: Array<{ name: string; in: string }> }>>;
    expect(paths['/users/{id}']).toBeDefined();
    const params = paths['/users/{id}']!.get!.parameters;
    expect(params).toContainEqual(expect.objectContaining({ name: 'id', in: 'path', required: true }));
  });

  it('routes non-path GET input to query params and POST input to requestBody (minus path params)', () => {
    const doc = buildOpenApiDocument(
      [
        tool({ method: 'GET', path: '/search', name: 'get_search', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }),
        tool({ method: 'POST', path: '/users/:id/posts', name: 'post', inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] } }),
      ],
      { title: 'API', version: '1.0.0' },
    );
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const getParams = paths['/search']!.get!.parameters as Array<{ name: string; in: string; required?: boolean }>;
    expect(getParams).toContainEqual(expect.objectContaining({ name: 'q', in: 'query', required: true }));

    const body = paths['/users/{id}/posts']!.post!.requestBody as { content: { 'application/json': { schema: { properties: Record<string, unknown> } } } };
    const bodyProps = body.content['application/json'].schema.properties;
    expect(bodyProps).toHaveProperty('title');
    expect(bodyProps).not.toHaveProperty('id'); // path param excluded from body
  });

  it('emits the response schema from outputSchema and provenance extensions', () => {
    const doc = buildOpenApiDocument(
      [tool({ method: 'GET', path: '/u', name: 'get_u', toolId: 'deadbe', outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } })],
      { title: 'API', version: '1.0.0' },
    );
    const op = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)['/u']!.get!;
    const responses = op.responses as { '200': { content?: { 'application/json': { schema: unknown } } } };
    expect(responses['200'].content?.['application/json'].schema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
    expect(op['x-surfacemcp-tool-id']).toBe('deadbe');
  });
});

describe('buildOpenApiResult — GraphQL tools', () => {
  it('skips GraphQL tools (they share one endpoint) and reports the count', () => {
    const rest = tool({ method: 'GET', path: '/rest', name: 'get_rest' });
    const gql = {
      ...tool({ method: 'POST', path: '/graphql', name: 'query_user' }),
      graphql: { operationType: 'query' as const, field: 'user', args: [] },
    };
    const { document, skippedGraphql } = buildOpenApiResult([rest, gql], { title: 'API', version: '1.0.0' });
    expect(skippedGraphql).toBe(1);
    const paths = document.paths as Record<string, unknown>;
    expect(paths).toHaveProperty('/rest');
    expect(paths).not.toHaveProperty('/graphql'); // GraphQL op omitted, not collapsed
  });
});
