import { describe, it, expect } from 'vitest';
import { parse } from 'graphql';
import { buildGraphqlOperation, buildGraphqlBody, GraphqlDescriptorError } from './graphql-request.js';
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

// #gql-injection: descriptor fields come from the TARGET project (SDL, or arbitrary
// decorator string literals for code-first). None of these may splice extra text
// into the emitted operation — a second operation would run against the target with
// an authenticated role session.
describe('buildGraphqlOperation — hostile descriptors', () => {
  /** Number of top-level operations in a document, or -1 when it does not parse. */
  function definitionCount(op: string): number {
    try {
      return parse(op).definitions.length;
    } catch {
      return -1;
    }
  }

  it('refuses a field name that closes the selection and opens a second operation', () => {
    expect(() =>
      buildGraphqlOperation({ operationType: 'query', field: 'me { password } query evil', args: [], selection: 'id' })
    ).toThrow(GraphqlDescriptorError);
  });

  it('refuses an argument type that escapes the variable declarations', () => {
    expect(() =>
      buildGraphqlOperation({
        operationType: 'query',
        field: 'me',
        args: [{ name: 'id', gqlType: 'String!) { adminSecrets } query x($z: String' }],
        selection: 'id',
      })
    ).toThrow(GraphqlDescriptorError);
  });

  it('refuses an argument name carrying GraphQL punctuation', () => {
    expect(() =>
      buildGraphqlOperation({
        operationType: 'query',
        field: 'me',
        args: [{ name: 'a) { secrets } query z(', gqlType: 'String' }],
        selection: 'id',
      })
    ).toThrow(GraphqlDescriptorError);
  });

  it('refuses an unknown operation type', () => {
    expect(() =>
      buildGraphqlOperation({
        operationType: 'subscription' as 'query',
        field: 'me',
        args: [],
        selection: 'id',
      })
    ).toThrow(GraphqlDescriptorError);
  });

  it('degrades a hostile selection to __typename instead of emitting it', () => {
    const op = buildGraphqlOperation({
      operationType: 'query',
      field: 'me',
      args: [],
      selection: 'id } query pwn { adminTokens',
    });
    expect(op).toBe('query me { me { __typename } }');
    expect(op).not.toContain('adminTokens');
    expect(definitionCount(op)).toBe(1);
  });

  it('never emits a document with more than one operation', () => {
    const hostile: GraphQLToolDescriptor[] = [
      { operationType: 'query', field: 'me { password } query evil', args: [], selection: 'id' },
      { operationType: 'query', field: 'me', args: [{ name: 'id', gqlType: 'ID!) { secrets } query y($q: ID' }] },
      { operationType: 'mutation', field: 'go', args: [{ name: 'x) { s } mutation m(', gqlType: 'ID' }] },
      { operationType: 'query', field: 'me', args: [], selection: 'a } query b { c' },
      { operationType: 'query', field: 'me', args: [], selection: 'id @include(if: true)' },
      { operationType: 'query', field: 'me', args: [], selection: '...AllFields' },
    ];
    for (const desc of hostile) {
      let op: string;
      try {
        op = buildGraphqlOperation(desc);
      } catch (err) {
        expect(err).toBeInstanceOf(GraphqlDescriptorError); // refused outright
        continue;
      }
      expect(definitionCount(op)).toBe(1); // emitted, but still exactly one operation
    }
  });

  it('still accepts every legitimate descriptor shape', () => {
    const op = buildGraphqlOperation({
      operationType: 'mutation',
      field: 'createUser',
      args: [
        { name: 'input', gqlType: 'NewUserInput!' },
        { name: 'tags', gqlType: '[String!]' },
      ],
      selection: 'id name author { id name }',
    });
    expect(op).toBe(
      'mutation createUser($input: NewUserInput!, $tags: [String!]) { createUser(input: $input, tags: $tags) { id name author { id name } } }'
    );
    expect(definitionCount(op)).toBe(1);
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
