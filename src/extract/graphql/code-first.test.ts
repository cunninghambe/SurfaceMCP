import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'graphql';
import { extractGraphqlCodeFirst } from './code-first.js';
import { buildGraphqlOperation } from '../../server/graphql-request.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const root = resolve(FIXTURES, 'graphql-codefirst-app');

function loadOps(): Array<{ toolId: string; name: string; operationType: string; field: string; sideEffectClass: string }> {
  const path = resolve(root, 'MUST_DISCOVER.json');
  return (
    JSON.parse(readFileSync(path, 'utf-8')) as {
      operations: Array<{ toolId: string; name: string; operationType: string; field: string; sideEffectClass: string }>;
    }
  ).operations;
}

describe('code-first graphql extraction (type-graphql)', () => {
  it('emits one tool per @Query/@Mutation with the SAME operation-keyed toolId scheme as schema-first', () => {
    const tools = extractGraphqlCodeFirst(root, '/graphql');
    const byId = new Map(tools.map((t) => [t.toolId, t]));
    for (const expected of loadOps()) {
      const t = byId.get(expected.toolId);
      expect(t, `missing code-first toolId=${expected.toolId} (${expected.name})`).toBeDefined();
      expect(t!.name).toBe(expected.name);
      expect(t!.sideEffectClass).toBe(expected.sideEffectClass);
      expect(t!.method).toBe('POST');
      expect(t!.path).toBe('/graphql');
      expect(t!.graphql?.operationType).toBe(expected.operationType);
      expect(t!.graphql?.field).toBe(expected.field);
    }
    expect(tools).toHaveLength(loadOps().length);
    expect(new Set(tools.map((t) => t.toolId)).size).toBe(tools.length);
    // toolId is byte-for-byte the schema-first formula sha1('graphql:query:recipes').
    expect(tools.find((t) => t.name === 'query_recipes')?.toolId).toBe('1d0bad65466b');
  });

  it('threads a custom graphqlPath without changing operation-keyed toolIds', () => {
    const tools = extractGraphqlCodeFirst(root, '/api/graphql');
    expect(tools.every((t) => t.path === '/api/graphql')).toBe(true);
    expect(tools.find((t) => t.graphql?.field === 'recipes')?.toolId).toBe('1d0bad65466b');
  });

  it('maps @Arg params to inputSchema, expanding @InputType classes', () => {
    const tools = extractGraphqlCodeFirst(root, '/graphql');
    const recipe = tools.find((t) => t.name === 'query_recipe');
    expect(recipe!.inputSchemaConfidence).toBe('inferred');
    expect(recipe!.inputSchema.properties?.id).toMatchObject({ type: 'string' });
    expect(recipe!.inputSchema.required).toEqual(['id']);

    const add = tools.find((t) => t.name === 'mutation_addRecipe');
    expect(add!.inputSchema.required).toEqual(['input']);
    const input = add!.inputSchema.properties?.input;
    expect(input?.type).toBe('object');
    expect(input?.properties?.title).toMatchObject({ type: 'string' });
    // `description` is @Field({ nullable: true }) → not required.
    expect(input?.required).toEqual(['title']);
    expect(input?.additionalProperties).toBe(false);
  });

  it('carries a graphql descriptor with SDL arg types and a bounded nested selection', () => {
    const tools = extractGraphqlCodeFirst(root, '/graphql');
    const recipe = tools.find((t) => t.name === 'query_recipe');
    expect(recipe!.graphql).toEqual({
      operationType: 'query',
      field: 'recipe',
      args: [{ name: 'id', gqlType: 'ID!' }],
      // Recipe scalar leaves + nested Rating object expanded one level deeper.
      selection: 'id title description ratings { stars comment }',
    });
    const add = tools.find((t) => t.name === 'mutation_addRecipe');
    expect(add!.graphql?.args).toEqual([{ name: 'input', gqlType: 'NewRecipeInput!' }]);
    expect(tools.find((t) => t.name === 'query_recipes')?.graphql?.args).toEqual([]);
  });

  it('builds a nested outputSchema from the returned @ObjectType', () => {
    const tools = extractGraphqlCodeFirst(root, '/graphql');
    const recipes = tools.find((t) => t.name === 'query_recipes');
    // @Query(() => [Recipe]) → array of the Recipe object shape.
    expect(recipes!.outputSchema?.type).toBe('array');
    const item = recipes!.outputSchema?.items;
    expect(item?.properties?.id).toMatchObject({ type: 'string' });
    expect(item?.properties?.ratings?.type).toBe('array');
    expect(item?.properties?.ratings?.items?.properties?.stars).toMatchObject({ type: 'integer' });
  });

  it('normalizes sourceFile to posix separators and points at the resolver', () => {
    const tools = extractGraphqlCodeFirst(root, '/graphql');
    for (const t of tools) {
      expect(t.sourceFile).toBe('src/recipe.resolver.ts');
      expect(t.sourceFile.includes('\\')).toBe(false);
    }
  });

  it('emits operation strings that parse as valid GraphQL documents', () => {
    const tools = extractGraphqlCodeFirst(root, '/graphql');
    for (const t of tools) {
      const op = buildGraphqlOperation(t.graphql!);
      expect(() => parse(op), `${t.name}: ${op}`).not.toThrow();
    }
    const add = tools.find((t) => t.name === 'mutation_addRecipe')!;
    expect(buildGraphqlOperation(add.graphql!)).toBe(
      'mutation addRecipe($input: NewRecipeInput!) { addRecipe(input: $input) { id title description ratings { stars comment } } }',
    );
  });

  it('returns [] for a project with no resolver classes', () => {
    expect(extractGraphqlCodeFirst(resolve(FIXTURES, 'graphql-app'), '/graphql')).toEqual([]);
  });
});
