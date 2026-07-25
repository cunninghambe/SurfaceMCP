import { describe, it, expect } from 'vitest';
import { inferJsonSchema, mergeSchemas } from './infer-schema.js';
import { CoverageTracker } from './coverage.js';
import type { ToolMeta, SurfaceCallResult } from '../types.js';

function tool(over: Partial<ToolMeta> = {}): ToolMeta {
  return {
    name: 'get_users', bareName: 'get_users', surface: 's', toolId: 'aaa111',
    method: 'GET', path: '/users', inputSchema: { type: 'object' },
    inputSchemaConfidence: 'unknown', sideEffectClass: 'safe',
    sourceFile: 'x', sourceLine: 1, isServerAction: false, ...over,
  };
}
function result(over: Partial<SurfaceCallResult> = {}): SurfaceCallResult {
  return { ok: true, status: 200, durationMs: 5, revisionAtCall: 1, ...over };
}

describe('inferJsonSchema', () => {
  it('infers object shape with required keys', () => {
    const s = inferJsonSchema({ id: 1, name: 'a', active: true });
    expect(s.type).toBe('object');
    expect(s.properties?.id?.type).toBe('integer');
    expect(s.properties?.name?.type).toBe('string');
    expect(s.properties?.active?.type).toBe('boolean');
    expect(s.required?.sort()).toEqual(['active', 'id', 'name']);
  });

  it('infers arrays by merging element schemas', () => {
    const s = inferJsonSchema([{ a: 1 }, { a: 2 }]);
    expect(s.type).toBe('array');
    expect(s.items?.properties?.a?.type).toBe('integer');
  });

  it('distinguishes integer from number, and handles null', () => {
    expect(inferJsonSchema(3).type).toBe('integer');
    expect(inferJsonSchema(3.5).type).toBe('number');
    expect(inferJsonSchema(null).type).toBe('null');
  });

  it('is depth-bounded on deeply nested input', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i++) deep = { nest: deep };
    expect(() => inferJsonSchema(deep)).not.toThrow();
  });
});

describe('mergeSchemas', () => {
  it('makes a key optional when absent from one observation', () => {
    const merged = mergeSchemas(
      inferJsonSchema({ id: 1, extra: 'x' }),
      inferJsonSchema({ id: 2 })
    );
    expect(merged.required).toEqual(['id']); // `extra` is no longer required
    expect(Object.keys(merged.properties ?? {}).sort()).toEqual(['extra', 'id']);
  });

  it('widens a type union across observations', () => {
    const merged = mergeSchemas(inferJsonSchema('a'), inferJsonSchema(null));
    expect(merged.type).toEqual(['string', 'null']);
  });

  it('widens integer to number when both are seen', () => {
    const merged = mergeSchemas(inferJsonSchema(1), inferJsonSchema(1.5));
    expect(merged.type).toBe('number');
  });
});

describe('CoverageTracker', () => {
  it('records calls, statuses, and learns a response schema', () => {
    const t = new CoverageTracker();
    const tl = tool();
    t.record(tl, result({ body: { id: 1, name: 'a' } }));
    t.record(tl, result({ status: 404, ok: false, body: { error: 'nope' } }));

    const snap = t.snapshot([tl]);
    expect(snap.summary.toolsCalled).toBe(1);
    expect(snap.summary.totalCalls).toBe(2);
    expect(snap.tools[0]!.statuses).toEqual({ '200': 1, '404': 1 });
    // Only the successful body taught the schema.
    expect(snap.tools[0]!.observations).toBe(1);
    expect(t.learnedSchemaFor('aaa111')?.properties?.name?.type).toBe('string');
  });

  it('does NOT count dry runs or pre-flight refusals as coverage', () => {
    const t = new CoverageTracker();
    const tl = tool();
    t.record(tl, result({ dryRun: { method: 'GET', url: 'http://x/users', headers: {} } }));
    t.record(tl, { ok: false, error: { code: 'read_only_blocked', message: 'x' }, durationMs: 0, revisionAtCall: 1 });
    t.record(tl, { ok: false, error: { code: 'external_blocked', message: 'x' }, durationMs: 0, revisionAtCall: 1 });

    const snap = t.snapshot([tl]);
    expect(snap.summary.toolsCalled).toBe(0);
    expect(snap.summary.totalCalls).toBe(0);
    expect(snap.uncalled).toEqual(['get_users']);
  });

  it('counts a fetch_error as an attempt (it reached the network)', () => {
    const t = new CoverageTracker();
    const tl = tool();
    t.record(tl, { ok: false, error: { code: 'fetch_error', message: 'ECONNREFUSED' }, durationMs: 1, revisionAtCall: 1 });
    expect(t.snapshot([tl]).summary.totalCalls).toBe(1);
  });

  it('does not learn from a truncated body', () => {
    const t = new CoverageTracker();
    const tl = tool();
    t.record(tl, result({ body: { partial: true }, bodyTruncated: true }));
    expect(t.learnedSchemaFor('aaa111')).toBeUndefined();
  });

  it('reports uncalled tools and discovery gaps', () => {
    const t = new CoverageTracker();
    const called = tool({ toolId: 'aaa111', name: 'get_users' });
    const never = tool({ toolId: 'bbb222', name: 'post_users', inputSchemaConfidence: 'unknown' });
    t.record(called, result({ body: { ok: true } }));

    const snap = t.snapshot([called, never]);
    expect(snap.summary.toolsTotal).toBe(2);
    expect(snap.summary.toolsUncalled).toBe(1);
    expect(snap.uncalled).toEqual(['post_users']);
    expect(snap.summary.inputSchemaUnknown).toBe(2);
    // `called` learned a schema, so only `never` lacks output typing.
    expect(snap.summary.outputSchemaMissing).toBe(1);
    // Stable ordering by toolId.
    expect(snap.tools.map((x) => x.toolId)).toEqual(['aaa111', 'bbb222']);
  });

  it('never throws on a hostile body', () => {
    const t = new CoverageTracker();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => t.record(tool(), result({ body: cyclic }))).not.toThrow();
  });
});
