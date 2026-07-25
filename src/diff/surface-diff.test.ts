import { describe, it, expect } from 'vitest';
import { diffCatalogs, formatDiffSummary, type ToolChange } from './surface-diff.js';
import type { JsonSchema2020, ToolMeta } from '../types.js';

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

/** Diff a single tool against a mutated copy of itself and return its changes. */
function changesFor(before: Partial<ToolMeta>, after: Partial<ToolMeta>): ToolChange[] {
  const diff = diffCatalogs(
    [tool({ toolId: 'aaa111', ...before })],
    [tool({ toolId: 'aaa111', ...after })]
  );
  return diff.changed[0]?.changes ?? [];
}

function findChange(changes: ToolChange[], property: string): ToolChange | undefined {
  return changes.find((c) => c.property === property);
}

const obj = (properties: Record<string, JsonSchema2020>, required?: string[]): JsonSchema2020 => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});

describe('diffCatalogs — added / removed / changed', () => {
  it('reports a tool present only in after as added and non-breaking', () => {
    const diff = diffCatalogs([], [tool({ toolId: 'bbb222', name: 'post_users', method: 'POST' })]);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toMatchObject({ toolId: 'bbb222', name: 'post_users', method: 'POST', breaking: false });
    expect(diff.summary).toMatchObject({ added: 1, removed: 0, changed: 0, breakingTools: 0, breakingChanges: 0 });
  });

  it('reports a tool present only in before as removed and breaking', () => {
    const diff = diffCatalogs([tool({ toolId: 'bbb222' })], []);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]).toMatchObject({ toolId: 'bbb222', breaking: true });
    expect(diff.summary).toMatchObject({ removed: 1, breakingTools: 1, breakingChanges: 1 });
  });

  it('counts identical tools as unchanged and emits no entries', () => {
    const before = [tool({ toolId: 'aaa111' }), tool({ toolId: 'ccc333', path: '/posts' })];
    const diff = diffCatalogs(before, before.map((t) => ({ ...t })));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.summary.unchanged).toBe(2);
  });

  it('ignores key order and annotative keywords (description/default/title)', () => {
    const changes = changesFor(
      { inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'old' } } } },
      { inputSchema: { properties: { q: { description: 'new', type: 'string', default: 'x' } }, type: 'object' } }
    );
    expect(changes).toEqual([]);
  });
});

describe('diffCatalogs — breaking rules (input schema)', () => {
  it('BREAKING: a new required input property', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }, ['a']) },
      { inputSchema: obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']) }
    );
    const c = findChange(changes, 'b')!;
    expect(c).toMatchObject({ field: 'inputSchema', kind: 'added', breaking: true });
  });

  it('NON-BREAKING: a new optional input property', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }, ['a']) },
      { inputSchema: obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']) }
    );
    expect(findChange(changes, 'b')).toMatchObject({ kind: 'added', breaking: false });
  });

  it('BREAKING: a removed input property that was required', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']) },
      { inputSchema: obj({ a: { type: 'string' } }, ['a']) }
    );
    expect(findChange(changes, 'b')).toMatchObject({ kind: 'removed', breaking: true });
  });

  it('NON-BREAKING: a removed input property that was optional', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']) },
      { inputSchema: obj({ a: { type: 'string' } }, ['a']) }
    );
    expect(findChange(changes, 'b')).toMatchObject({ kind: 'removed', breaking: false });
  });

  it('BREAKING: an existing optional input property becoming required', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }) },
      { inputSchema: obj({ a: { type: 'string' } }, ['a']) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'became_required', breaking: true });
  });

  it('NON-BREAKING: a required input property becoming optional', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }, ['a']) },
      { inputSchema: obj({ a: { type: 'string' } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'became_optional', breaking: false });
  });

  it('BREAKING: an input type narrowed (union shrinks)', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: ['string', 'number'] } }) },
      { inputSchema: obj({ a: { type: 'string' } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'narrowed', breaking: true, before: 'number|string', after: 'string' });
  });

  it('NON-BREAKING: an input type widened (union grows)', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }) },
      { inputSchema: obj({ a: { type: ['string', 'number'] } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'widened', breaking: false });
  });

  it('NON-BREAKING: integer widened to number (integer is a subset of number)', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'integer' } }) },
      { inputSchema: obj({ a: { type: 'number' } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'widened', breaking: false });
  });

  it('BREAKING: an untyped input property becoming typed', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: {} }) },
      { inputSchema: obj({ a: { type: 'string' } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'narrowed', breaking: true, before: 'any' });
  });

  it('BREAKING: an incompatible retype (string -> number)', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }) },
      { inputSchema: obj({ a: { type: 'number' } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'retyped', breaking: true });
  });

  it('BREAKING: a new enum constraint; NON-BREAKING: enum dropped', () => {
    const narrowed = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }) },
      { inputSchema: obj({ a: { type: 'string', enum: ['x', 'y'] } }) }
    );
    expect(findChange(narrowed, 'a')).toMatchObject({ kind: 'narrowed', breaking: true });

    const widened = changesFor(
      { inputSchema: obj({ a: { type: 'string', enum: ['x', 'y'] } }) },
      { inputSchema: obj({ a: { type: 'string' } }) }
    );
    expect(findChange(widened, 'a')).toMatchObject({ kind: 'widened', breaking: false });
  });

  it('BREAKING: an enum losing a member; NON-BREAKING: an enum gaining one', () => {
    const shrunk = changesFor(
      { inputSchema: obj({ a: { type: 'string', enum: ['x', 'y'] } }) },
      { inputSchema: obj({ a: { type: 'string', enum: ['x'] } }) }
    );
    expect(findChange(shrunk, 'a')).toMatchObject({ kind: 'narrowed', breaking: true });

    const grew = changesFor(
      { inputSchema: obj({ a: { type: 'string', enum: ['x'] } }) },
      { inputSchema: obj({ a: { type: 'string', enum: ['x', 'y'] } }) }
    );
    expect(findChange(grew, 'a')).toMatchObject({ kind: 'widened', breaking: false });
  });

  it('BREAKING: enum members swapped wholesale', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string', enum: ['x'] } }) },
      { inputSchema: obj({ a: { type: 'string', enum: ['y'] } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'retyped', breaking: true });
  });

  it('BREAKING: an input constraint tightened; NON-BREAKING: loosened', () => {
    const tightened = changesFor(
      { inputSchema: obj({ a: { type: 'string', minLength: 1 } }) },
      { inputSchema: obj({ a: { type: 'string', minLength: 5 } }) }
    );
    expect(findChange(tightened, 'a')).toMatchObject({ kind: 'constraint_tightened', breaking: true, before: '1', after: '5' });

    const loosened = changesFor(
      { inputSchema: obj({ a: { type: 'string', maxLength: 10 } }) },
      { inputSchema: obj({ a: { type: 'string', maxLength: 50 } }) }
    );
    expect(findChange(loosened, 'a')).toMatchObject({ kind: 'constraint_loosened', breaking: false });
  });

  it('BREAKING: a constraint appearing where there was none', () => {
    const changes = changesFor(
      { inputSchema: obj({ a: { type: 'string' } }) },
      { inputSchema: obj({ a: { type: 'string', pattern: '^x' } }) }
    );
    expect(findChange(changes, 'a')).toMatchObject({ kind: 'constraint_tightened', breaking: true, before: 'none' });
  });

  it('recurses into nested objects and array items with dotted/[] paths', () => {
    const changes = changesFor(
      { inputSchema: obj({ user: obj({ email: { type: 'string' } }), tags: { type: 'array', items: { type: 'string' } } }) },
      {
        inputSchema: obj({
          user: obj({ email: { type: 'string' }, age: { type: 'integer' } }, ['age']),
          tags: { type: 'array', items: { type: 'number' } },
        }),
      }
    );
    expect(findChange(changes, 'user.age')).toMatchObject({ kind: 'added', breaking: true });
    expect(findChange(changes, 'tags[]')).toMatchObject({ kind: 'retyped', breaking: true });
  });

  it('BREAKING: an input schema appearing where the tool advertised none', () => {
    const changes = changesFor(
      { inputSchema: undefined as unknown as JsonSchema2020 },
      { inputSchema: obj({ a: { type: 'string' } }, ['a']) }
    );
    expect(findChange(changes, '')).toMatchObject({ field: 'inputSchema', kind: 'added', breaking: true });
  });
});

describe('diffCatalogs — output schema polarity is inverted', () => {
  it('BREAKING: an output property removed; NON-BREAKING: one added', () => {
    const removed = changesFor(
      { outputSchema: obj({ id: { type: 'string' }, name: { type: 'string' } }) },
      { outputSchema: obj({ id: { type: 'string' } }) }
    );
    expect(findChange(removed, 'name')).toMatchObject({ field: 'outputSchema', kind: 'removed', breaking: true });

    const added = changesFor(
      { outputSchema: obj({ id: { type: 'string' } }) },
      { outputSchema: obj({ id: { type: 'string' }, name: { type: 'string' } }, ['name']) }
    );
    expect(findChange(added, 'name')).toMatchObject({ kind: 'added', breaking: false });
  });

  it('BREAKING: an output property widened or de-guaranteed', () => {
    const widened = changesFor(
      { outputSchema: obj({ id: { type: 'string' } }) },
      { outputSchema: obj({ id: { type: ['string', 'null'] } }) }
    );
    expect(findChange(widened, 'id')).toMatchObject({ kind: 'widened', breaking: true });

    const optional = changesFor(
      { outputSchema: obj({ id: { type: 'string' } }, ['id']) },
      { outputSchema: obj({ id: { type: 'string' } }) }
    );
    expect(findChange(optional, 'id')).toMatchObject({ kind: 'became_optional', breaking: true });
  });

  it('BREAKING: the whole output schema disappearing; NON-BREAKING: it appearing', () => {
    const gone = changesFor({ outputSchema: obj({ id: { type: 'string' } }) }, { outputSchema: undefined });
    expect(findChange(gone, '')).toMatchObject({ field: 'outputSchema', kind: 'removed', breaking: true });

    const gained = changesFor({ outputSchema: undefined }, { outputSchema: obj({ id: { type: 'string' } }) });
    expect(findChange(gained, '')).toMatchObject({ field: 'outputSchema', kind: 'added', breaking: false });
  });
});

describe('diffCatalogs — scalar field rules', () => {
  it('BREAKING: safe -> mutating reclassification', () => {
    const changes = changesFor({ sideEffectClass: 'safe' }, { sideEffectClass: 'mutating' });
    expect(changes).toEqual([
      expect.objectContaining({ field: 'sideEffectClass', kind: 'replaced', before: 'safe', after: 'mutating', breaking: true }),
    ]);
  });

  it('BREAKING: safe -> external; NON-BREAKING: mutating -> safe and mutating -> external', () => {
    expect(changesFor({ sideEffectClass: 'safe' }, { sideEffectClass: 'external' })[0]).toMatchObject({ breaking: true });
    expect(changesFor({ sideEffectClass: 'mutating' }, { sideEffectClass: 'safe' })[0]).toMatchObject({ breaking: false });
    expect(changesFor({ sideEffectClass: 'mutating' }, { sideEffectClass: 'external' })[0]).toMatchObject({ breaking: false });
  });

  it('NON-BREAKING: confidence changes in either direction, with a direction-aware reason', () => {
    const improved = changesFor({ inputSchemaConfidence: 'unknown' }, { inputSchemaConfidence: 'introspected' });
    expect(improved[0]).toMatchObject({ field: 'inputSchemaConfidence', breaking: false });
    expect(improved[0]!.reason).toContain('improved');

    const degraded = changesFor({ inputSchemaConfidence: 'introspected' }, { inputSchemaConfidence: 'partial' });
    expect(degraded[0]).toMatchObject({ breaking: false });
    expect(degraded[0]!.reason).toContain('degraded');
  });

  it('NON-BREAKING: a rename', () => {
    const changes = changesFor({ name: 'get_users' }, { name: 'app:get_users' });
    expect(changes).toEqual([expect.objectContaining({ field: 'name', breaking: false })]);
  });

  it('BREAKING: the same toolId moving to a different method/path', () => {
    const changes = changesFor({ method: 'GET', path: '/users' }, { method: 'POST', path: '/people' });
    expect(changes.filter((c) => c.breaking)).toHaveLength(2);
    expect(changes.map((c) => c.field)).toEqual(['method', 'path']);
  });
});

describe('diffCatalogs — determinism', () => {
  it('sorts added/removed/changed by toolId regardless of input order', () => {
    const before = [tool({ toolId: 'ccc' }), tool({ toolId: 'aaa' }), tool({ toolId: 'bbb' })];
    const after = [
      tool({ toolId: 'zzz' }),
      tool({ toolId: 'aaa', sideEffectClass: 'mutating' }),
      tool({ toolId: 'yyy' }),
      tool({ toolId: 'bbb', sideEffectClass: 'mutating' }),
    ];
    const diff = diffCatalogs(before, after);
    expect(diff.added.map((t) => t.toolId)).toEqual(['yyy', 'zzz']);
    expect(diff.removed.map((t) => t.toolId)).toEqual(['ccc']);
    expect(diff.changed.map((t) => t.toolId)).toEqual(['aaa', 'bbb']);
  });

  it('produces byte-identical JSON when the inputs are shuffled', () => {
    const mk = (id: string, mutate: boolean): ToolMeta =>
      tool({
        toolId: id,
        inputSchema: obj({ a: { type: 'string' }, b: { type: mutate ? 'number' : 'string' } }, mutate ? ['a', 'b'] : ['a']),
      });
    const before = ['a1', 'b2', 'c3'].map((id) => mk(id, false));
    const after = ['a1', 'b2', 'c3'].map((id) => mk(id, true));

    const straight = JSON.stringify(diffCatalogs(before, after));
    const shuffled = JSON.stringify(diffCatalogs([...before].reverse(), [...after].reverse()));
    expect(shuffled).toBe(straight);
  });

  it('orders a tool\'s changes by field, then property, then kind', () => {
    const changes = changesFor(
      {
        sideEffectClass: 'safe',
        inputSchema: obj({ b: { type: 'string' }, a: { type: 'string' } }),
        outputSchema: obj({ z: { type: 'string' } }),
      },
      {
        sideEffectClass: 'mutating',
        inputSchema: obj({ b: { type: 'number' }, a: { type: 'number' } }),
        outputSchema: obj({}),
      }
    );
    expect(changes.map((c) => `${c.field}:${c.property ?? ''}`)).toEqual([
      'sideEffectClass:',
      'inputSchema:a',
      'inputSchema:b',
      'outputSchema:z',
    ]);
  });
});

describe('diffCatalogs — empty and degenerate catalogs', () => {
  it('returns an all-zero diff for two empty catalogs', () => {
    const diff = diffCatalogs([], []);
    expect(diff).toEqual({
      added: [],
      removed: [],
      changed: [],
      summary: { added: 0, removed: 0, changed: 0, unchanged: 0, breakingTools: 0, breakingChanges: 0 },
    });
  });

  it('treats an empty after-catalog as a full removal', () => {
    const before = [tool({ toolId: 'a1' }), tool({ toolId: 'b2' })];
    const diff = diffCatalogs(before, []);
    expect(diff.summary).toMatchObject({ removed: 2, breakingTools: 2, breakingChanges: 2 });
    expect(diff.removed.every((r) => r.breaking)).toBe(true);
  });

  it('treats an empty before-catalog as an all-new surface with no breakage', () => {
    const diff = diffCatalogs([], [tool({ toolId: 'a1' }), tool({ toolId: 'b2' })]);
    expect(diff.summary).toMatchObject({ added: 2, breakingTools: 0, breakingChanges: 0 });
  });

  it('tolerates tools with no inputSchema on both sides', () => {
    const bare = { ...tool({ toolId: 'a1' }), inputSchema: undefined as unknown as JsonSchema2020 };
    expect(diffCatalogs([bare], [{ ...bare }]).summary.unchanged).toBe(1);
  });
});

describe('diffCatalogs — GraphQL tools (operation-keyed ids)', () => {
  const gql = (toolId: string, field: string, operationType: 'query' | 'mutation', args: Array<{ name: string; gqlType: string }> = []): ToolMeta => ({
    ...tool({
      toolId,
      name: `${operationType}_${field}`,
      bareName: `${operationType}_${field}`,
      method: 'POST',
      path: '/graphql',
      sideEffectClass: operationType === 'query' ? 'safe' : 'mutating',
      inputSchemaConfidence: 'introspected',
    }),
    graphql: { operationType, field, args, selection: 'id name' },
  });

  it('keeps distinct operations on the same POST /graphql path separate', () => {
    // Every GraphQL tool shares `POST /graphql`; only the operation-keyed toolId
    // tells them apart, so the diff must key on toolId and never on method:path.
    const before = [gql('g1', 'user', 'query'), gql('g2', 'createUser', 'mutation')];
    const after = [gql('g1', 'user', 'query'), gql('g3', 'deleteUser', 'mutation')];
    const diff = diffCatalogs(before, after);
    expect(diff.added.map((t) => t.name)).toEqual(['mutation_deleteUser']);
    expect(diff.removed.map((t) => t.name)).toEqual(['mutation_createUser']);
    expect(diff.summary.unchanged).toBe(1);
    // Removing a mutation is breaking even though `POST /graphql` still exists.
    expect(diff.summary.breakingTools).toBe(1);
  });

  it('detects a required GraphQL argument added to an existing operation', () => {
    const before = [{ ...gql('g1', 'user', 'query', [{ name: 'id', gqlType: 'ID!' }]), inputSchema: obj({ id: { type: 'string' } }, ['id']) }];
    const after = [
      {
        ...gql('g1', 'user', 'query', [{ name: 'id', gqlType: 'ID!' }, { name: 'tenant', gqlType: 'ID!' }]),
        inputSchema: obj({ id: { type: 'string' }, tenant: { type: 'string' } }, ['id', 'tenant']),
      },
    ];
    const diff = diffCatalogs(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.breaking).toBe(true);
    expect(findChange(diff.changed[0]!.changes, 'tenant')).toMatchObject({ kind: 'added', breaking: true });
  });

  it('flags a GraphQL query reclassified to a mutation as breaking', () => {
    const diff = diffCatalogs([gql('g1', 'user', 'query')], [{ ...gql('g1', 'user', 'query'), sideEffectClass: 'mutating' }]);
    expect(diff.changed[0]!.breaking).toBe(true);
  });
});

describe('formatDiffSummary', () => {
  it('renders counts, per-tool lines, and a breaking marker', () => {
    const diff = diffCatalogs(
      [tool({ toolId: 'a1', name: 'get_gone', path: '/gone' }), tool({ toolId: 'b2', inputSchema: obj({ q: { type: 'string' } }) })],
      [tool({ toolId: 'b2', inputSchema: obj({ q: { type: 'string' } }, ['q']) }), tool({ toolId: 'c3', name: 'get_new', path: '/new' })]
    );
    const text = formatDiffSummary(diff);
    expect(text).toContain('+1 added, -1 removed, ~1 changed');
    expect(text).toContain('[BREAKING] removed  GET /gone');
    expect(text).toContain('+ added    GET /new');
    expect(text).toContain('[BREAKING] inputSchema:q became_required');
    expect(text).toContain('2 tool(s) with breaking changes');
  });

  it('says so plainly when nothing is breaking', () => {
    const diff = diffCatalogs([], [tool({ toolId: 'a1' })]);
    expect(formatDiffSummary(diff)).toContain('No breaking changes.');
  });
});
