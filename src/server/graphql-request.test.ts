import { describe, it, expect } from 'vitest';
import { parse } from 'graphql';
import { buildGraphqlOperation, buildGraphqlBody } from './graphql-request.js';
import type { GraphQLToolDescriptor } from '../types.js';

describe('buildGraphqlOperation', () => {
  it('builds a query with variable declarations and a selection set', () => {
    const desc: GraphQLToolDescriptor = {
      operationType: 'query',
      field: 'user',
      args: [{ name: 'id', gqlType: 'ID!' }],
      selection: 'id name email',
    };
    const op = buildGraphqlOperation(desc);
    expect(op).toBe('query user($id: ID!) { user(id: $id) { id name email } }');
    expect(() => parse(op)).not.toThrow(); // valid GraphQL document
  });

  it('omits the parens for an argument-less field', () => {
    const op = buildGraphqlOperation({
      operationType: 'query',
      field: 'users',
      args: [],
      selection: 'id name',
    });
    expect(op).toBe('query users { users { id name } }');
    expect(() => parse(op)).not.toThrow();
  });

  it('omits the selection block for a scalar-returning field', () => {
    const op = buildGraphqlOperation({ operationType: 'query', field: 'count', args: [] });
    expect(op).toBe('query count { count }');
    expect(() => parse(op)).not.toThrow();
  });

  it('builds a mutation with a nested input-object variable', () => {
    const op = buildGraphqlOperation({
      operationType: 'mutation',
      field: 'createUser',
      args: [{ name: 'input', gqlType: 'NewUserInput!' }],
      selection: 'id name',
    });
    expect(op).toBe('mutation createUser($input: NewUserInput!) { createUser(input: $input) { id name } }');
    expect(() => parse(op)).not.toThrow();
  });

  it('emits multiple args in declaration order', () => {
    const op = buildGraphqlOperation({
      operationType: 'query',
      field: 'search',
      args: [
        { name: 'q', gqlType: 'String!' },
        { name: 'limit', gqlType: 'Int' },
      ],
      selection: 'id',
    });
    expect(op).toBe('query search($q: String!, $limit: Int) { search(q: $q, limit: $limit) { id } }');
    expect(() => parse(op)).not.toThrow();
  });
});

describe('buildGraphqlBody', () => {
  it('produces a `{ query, variables }` JSON body with the caller input as variables', () => {
    const body = buildGraphqlBody(
      { operationType: 'query', field: 'user', args: [{ name: 'id', gqlType: 'ID!' }], selection: 'id name' },
      { id: '42' },
    );
    const parsed = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
    expect(parsed.variables).toEqual({ id: '42' });
    expect(() => parse(parsed.query)).not.toThrow();
  });
});
