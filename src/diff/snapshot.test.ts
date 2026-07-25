import { describe, it, expect } from 'vitest';
import { buildSnapshot, parseSnapshot, serializeSnapshot, stableJson, SNAPSHOT_VERSION } from './snapshot.js';
import { diffCatalogs } from './surface-diff.js';
import type { ToolCatalog, ToolMeta } from '../types.js';

function tool(partial: Partial<ToolMeta> & Pick<ToolMeta, 'toolId'>): ToolMeta {
  return {
    name: 'get_users',
    bareName: 'get_users',
    surface: 'app',
    method: 'GET',
    path: '/users',
    inputSchema: { type: 'object' },
    inputSchemaConfidence: 'unknown',
    sideEffectClass: 'safe',
    sourceFile: 'src/routes.ts',
    sourceLine: 1,
    isServerAction: false,
    ...partial,
  };
}

const catalog = (tools: ToolMeta[], revision = 1): ToolCatalog => ({ revision, tools });

describe('buildSnapshot', () => {
  it('sorts tools by toolId and records surface + revision', () => {
    const snap = buildSnapshot('app', catalog([tool({ toolId: 'c3' }), tool({ toolId: 'a1' }), tool({ toolId: 'b2' })], 7));
    expect(snap.tools.map((t) => t.toolId)).toEqual(['a1', 'b2', 'c3']);
    expect(snap).toMatchObject({ snapshotVersion: SNAPSHOT_VERSION, surface: 'app', revision: 7 });
  });

  it('does not mutate the source catalog', () => {
    const cat = catalog([tool({ toolId: 'c3', sourceFile: 'src\\app.ts' }), tool({ toolId: 'a1' })]);
    buildSnapshot('app', cat);
    expect(cat.tools.map((t) => t.toolId)).toEqual(['c3', 'a1']);
    expect(cat.tools[0]!.sourceFile).toBe('src\\app.ts');
  });

  it('normalizes sourceFile to posix so a snapshot is stable across platforms', () => {
    const snap = buildSnapshot('app', catalog([tool({ toolId: 'a1', sourceFile: 'src\\routes\\users.ts' })]));
    expect(snap.tools[0]!.sourceFile).toBe('src/routes/users.ts');
  });
});

describe('serializeSnapshot', () => {
  it('emits stable key order regardless of insertion order', () => {
    const a = serializeSnapshot(buildSnapshot('app', catalog([tool({ toolId: 'a1' })])));
    const reordered = buildSnapshot('app', catalog([{ ...tool({ toolId: 'a1' }) }]));
    // Rebuild the tool with keys inserted in a different order.
    reordered.tools = reordered.tools.map((t) => {
      const flipped: Record<string, unknown> = {};
      for (const key of Object.keys(t).reverse()) flipped[key] = (t as unknown as Record<string, unknown>)[key];
      return flipped as unknown as ToolMeta;
    });
    expect(serializeSnapshot(reordered)).toBe(a);
  });

  it('sorts nested schema keys too and ends with a newline', () => {
    const json = serializeSnapshot(
      buildSnapshot('app', catalog([tool({ toolId: 'a1', inputSchema: { properties: { b: { type: 'string' }, a: { type: 'string' } }, type: 'object' } })]))
    );
    expect(json.endsWith('\n')).toBe(true);
    expect(json.indexOf('"properties"')).toBeLessThan(json.indexOf('"type": "object"'));
    const props = json.slice(json.indexOf('"properties"'));
    expect(props.indexOf('"a"')).toBeLessThan(props.indexOf('"b"'));
  });

  it('preserves array order (a required[] set is not silently rewritten)', () => {
    const json = serializeSnapshot(
      buildSnapshot('app', catalog([tool({ toolId: 'a1', inputSchema: { type: 'object', required: ['z', 'a'] } })]))
    );
    expect(JSON.parse(json).tools[0].inputSchema.required).toEqual(['z', 'a']);
  });

  it('drops undefined values rather than emitting them', () => {
    const json = serializeSnapshot(buildSnapshot('app', catalog([tool({ toolId: 'a1', outputSchema: undefined })])));
    expect(json).not.toContain('outputSchema');
  });

  it('round-trips through parseSnapshot', () => {
    const snap = buildSnapshot('app', catalog([tool({ toolId: 'a1' }), tool({ toolId: 'b2' })]));
    const parsed = parseSnapshot(JSON.parse(serializeSnapshot(snap)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot).toEqual(snap);
    expect(diffCatalogs(snap.tools, parsed.snapshot.tools).summary.unchanged).toBe(2);
  });
});

describe('parseSnapshot', () => {
  it('accepts a full snapshot envelope', () => {
    const parsed = parseSnapshot({ snapshotVersion: 1, surface: 'app', revision: 3, tools: [tool({ toolId: 'a1' })] });
    expect(parsed.ok && parsed.snapshot).toMatchObject({ surface: 'app', revision: 3 });
  });

  it('accepts a bare ToolCatalog', () => {
    const parsed = parseSnapshot({ revision: 4, tools: [tool({ toolId: 'a1' })] });
    expect(parsed.ok && parsed.snapshot.revision).toBe(4);
  });

  it('accepts a bare tool array', () => {
    const parsed = parseSnapshot([tool({ toolId: 'a1' })]);
    expect(parsed.ok && parsed.snapshot.tools).toHaveLength(1);
    expect(parsed.ok && parsed.snapshot.surface).toBe('');
  });

  it('rejects a non-object, a missing tools array, and tools without a toolId', () => {
    expect(parseSnapshot('nope')).toMatchObject({ ok: false, code: 'bad_snapshot' });
    expect(parseSnapshot({ surface: 'app' })).toMatchObject({ ok: false, code: 'bad_snapshot' });
    expect(parseSnapshot({ tools: [{ name: 'x' }] })).toMatchObject({ ok: false, code: 'bad_snapshot' });
    expect(parseSnapshot([{ name: 'x' }])).toMatchObject({ ok: false, code: 'bad_snapshot' });
  });

  it('rejects a snapshotVersion newer than this build understands', () => {
    const parsed = parseSnapshot({ snapshotVersion: SNAPSHOT_VERSION + 1, tools: [] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('unsupported snapshotVersion');
  });

  it('labels the failure with the caller-supplied label', () => {
    const parsed = parseSnapshot({}, 'before');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('before');
  });

  it('accepts an older snapshot with no snapshotVersion field', () => {
    const parsed = parseSnapshot({ tools: [tool({ toolId: 'a1' })] });
    expect(parsed.ok && parsed.snapshot.snapshotVersion).toBe(SNAPSHOT_VERSION);
  });
});

describe('stableJson', () => {
  it('canonicalizes an arbitrary diff payload and terminates with a newline', () => {
    const json = stableJson({ b: 1, a: { d: 2, c: 3 } });
    expect(json).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  });
});
