import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { extractGraphqlSchema } from './parse.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const root = resolve(FIXTURES, 'graphql-app');

function loadOps(): Array<{
  toolId: string;
  name: string;
  operationType: string;
  field: string;
  sideEffectClass: string;
}> {
  const path = resolve(root, 'MUST_DISCOVER.json');
  return (
    JSON.parse(readFileSync(path, 'utf-8')) as {
      operations: Array<{ toolId: string; name: string; operationType: string; field: string; sideEffectClass: string }>;
    }
  ).operations;
}

describe('graphql-app schema extraction', () => {
  it('emits one tool per top-level Query and Mutation field, with pinned operation-keyed toolIds', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    const byId = new Map(tools.map((t) => [t.toolId, t]));
    for (const expected of loadOps()) {
      const t = byId.get(expected.toolId);
      expect(t, `missing graphql operation toolId=${expected.toolId} (${expected.name})`).toBeDefined();
      expect(t!.name).toBe(expected.name);
      expect(t!.sideEffectClass).toBe(expected.sideEffectClass);
      expect(t!.method).toBe('POST');
      expect(t!.path).toBe('/graphql');
      expect(t!.graphql?.operationType).toBe(expected.operationType);
      expect(t!.graphql?.field).toBe(expected.field);
    }
    // No extras beyond the must-discover set, and toolIds are unique.
    expect(tools).toHaveLength(loadOps().length);
    expect(new Set(tools.map((t) => t.toolId)).size).toBe(tools.length);
  });

  it('assigns the operation-keyed toolId scheme sha1(graphql:<op>:<field>)', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    // Pinned values guard against any drift in the hashing formula.
    expect(tools.find((t) => t.name === 'query_users')?.toolId).toBe('affdded9d006');
    expect(tools.find((t) => t.name === 'query_user')?.toolId).toBe('e0ab004db53d');
    expect(tools.find((t) => t.name === 'mutation_createUser')?.toolId).toBe('012fa15afcec');
    for (const t of tools) expect(t.toolId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('threads a custom graphqlPath into the tool path without changing toolIds', () => {
    const tools = extractGraphqlSchema(root, '/api/graphql');
    expect(tools.every((t) => t.path === '/api/graphql')).toBe(true);
    // toolIds are operation-keyed, so they must not change with the path.
    expect(tools.find((t) => t.graphql?.field === 'users')?.toolId).toBe('affdded9d006');
  });

  it('builds inputSchema from field arguments (scalars, required `!`, nested input objects)', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    const userQuery = tools.find((t) => t.name === 'query_user');
    expect(userQuery!.inputSchemaConfidence).toBe('introspected');
    expect(userQuery!.inputSchema.properties?.id).toMatchObject({ type: 'string' });
    expect(userQuery!.inputSchema.required).toEqual(['id']);

    const createUser = tools.find((t) => t.name === 'mutation_createUser');
    expect(createUser!.inputSchema.required).toEqual(['input']);
    const inputProp = createUser!.inputSchema.properties?.input;
    expect(inputProp?.type).toBe('object');
    expect(inputProp?.properties?.name).toMatchObject({ type: 'string' });
    expect(inputProp?.properties?.age).toMatchObject({ type: 'integer' });
    // `name` + `email` are non-null in the input type → required; `age` is nullable → not.
    expect(inputProp?.required).toEqual(['name', 'email']);
  });

  it('builds outputSchema from the return type (one level deep; list wrapping preserved; enum → string enum)', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    const usersQuery = tools.find((t) => t.name === 'query_users');
    // [User!]! → array of the User object shape.
    expect(usersQuery!.outputSchema?.type).toBe('array');
    const item = usersQuery!.outputSchema?.items;
    expect(item?.type).toBe('object');
    expect(item?.properties?.id).toMatchObject({ type: 'string' });
    expect(item?.properties?.age).toMatchObject({ type: 'integer' });
    expect(item?.properties?.role).toMatchObject({ type: 'string', enum: ['ADMIN', 'MEMBER'] });

    const userQuery = tools.find((t) => t.name === 'query_user');
    expect(userQuery!.outputSchema?.type).toBe('object');
  });

  it('carries a graphql descriptor with arg SDL types and a shallow scalar selection set', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    const userQuery = tools.find((t) => t.name === 'query_user');
    expect(userQuery!.graphql).toEqual({
      operationType: 'query',
      field: 'user',
      args: [{ name: 'id', gqlType: 'ID!' }],
      selection: 'id name email age role',
    });
    // Argument-less fields carry an empty args list.
    expect(tools.find((t) => t.name === 'query_users')?.graphql?.args).toEqual([]);
  });

  it('normalizes sourceFile to posix separators', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    for (const t of tools) {
      expect(t.sourceFile).toBe('schema.graphql');
      expect(t.sourceFile.includes('\\')).toBe(false);
    }
  });

  it('returns [] for a directory with no SDL schema', () => {
    expect(extractGraphqlSchema(resolve(FIXTURES, 'fastify-app'), '/graphql')).toEqual([]);
  });
});
