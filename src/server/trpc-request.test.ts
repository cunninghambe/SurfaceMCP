import { describe, it, expect } from 'vitest';
import { buildTrpcRequest } from './trpc-request.js';

const endpoint = 'http://127.0.0.1:3000/api/trpc';

describe('buildTrpcRequest', () => {
  it('builds a query as GET <endpoint>/<dotted.path>?input=<url-encoded JSON>', () => {
    const req = buildTrpcRequest(
      { procedureType: 'query', procedurePath: 'post.byId' },
      endpoint,
      { id: '42' }
    );
    expect(req.body).toBeUndefined();
    const url = new URL(req.url);
    expect(url.pathname).toBe('/api/trpc/post.byId');
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ id: '42' });
  });

  it('omits the input parameter entirely for an input-less query', () => {
    const req = buildTrpcRequest({ procedureType: 'query', procedurePath: 'health' }, endpoint, {});
    expect(req.url).toBe('http://127.0.0.1:3000/api/trpc/health');
    expect(req.body).toBeUndefined();
  });

  it('builds a mutation as POST <endpoint>/<dotted.path> with the input as the JSON body', () => {
    const req = buildTrpcRequest(
      { procedureType: 'mutation', procedurePath: 'post.create' },
      endpoint,
      { title: 'Hi', body: 'there' }
    );
    expect(req.url).toBe('http://127.0.0.1:3000/api/trpc/post.create');
    expect(JSON.parse(req.body!)).toEqual({ title: 'Hi', body: 'there' });
  });

  it('sends no body for an input-less mutation', () => {
    const req = buildTrpcRequest({ procedureType: 'mutation', procedurePath: 'ping' }, endpoint, {});
    expect(req.body).toBeUndefined();
  });

  it('url-encodes reserved characters in the query input rather than leaking them into the URL', () => {
    const req = buildTrpcRequest(
      { procedureType: 'query', procedurePath: 'search' },
      endpoint,
      { q: 'a&b=c?d#e' }
    );
    expect(req.url).not.toContain('a&b=c');
    const url = new URL(req.url);
    expect(url.pathname).toBe('/api/trpc/search');
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ q: 'a&b=c?d#e' });
  });

  it('tolerates a trailing slash on the endpoint without doubling it', () => {
    const req = buildTrpcRequest(
      { procedureType: 'query', procedurePath: 'health' },
      'http://127.0.0.1:3000/api/trpc/',
      {}
    );
    expect(req.url).toBe('http://127.0.0.1:3000/api/trpc/health');
  });
});
