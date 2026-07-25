import { describe, it, expect } from 'vitest';
import { isGraphqlName, isGraphqlTypeRef, isGraphqlSelectionSet } from './graphql-names.js';

describe('isGraphqlName', () => {
  it('accepts the GraphQL Name production', () => {
    for (const n of ['id', '_id', '__typename', 'userName1', 'A', '_']) {
      expect(isGraphqlName(n)).toBe(true);
    }
  });

  it('rejects names carrying breakout characters or a leading digit', () => {
    for (const n of [
      '',
      '1abc',
      'a-b',
      'a b',
      'user$',
      'me { password } query evil',
      'me)',
      'me{',
      'me}',
      'a\nb',
      'a:b',
      'a,b',
      'a(b',
      'a@skip',
      'a...b',
    ]) {
      expect(isGraphqlName(n), n).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, ['id']]) {
      expect(isGraphqlName(v)).toBe(false);
    }
  });
});

describe('isGraphqlTypeRef', () => {
  it('accepts names, non-null markers and nested lists', () => {
    for (const t of ['ID', 'ID!', 'String', '[String]', '[String!]', '[String!]!', '[[Int!]!]!', 'NewUserInput!']) {
      expect(isGraphqlTypeRef(t), t).toBe(true);
    }
  });

  it('rejects the variable-declaration breakout from a crafted @Arg type', () => {
    // Splices a second operation out of `($id: <gqlType>)`.
    expect(isGraphqlTypeRef('String!) { adminSecrets } query x($z: String')).toBe(false);
  });

  it('rejects malformed or metacharacter-bearing type strings', () => {
    for (const t of [
      '',
      '!',
      'ID!!',
      '[ID',
      'ID]',
      '[]',
      '[ID]]',
      'ID String',
      'ID,String',
      '1Type',
      'Type$',
      'Type = 1',
      '{ evil }',
      'ID @deprecated',
      'ID\n',
      'a'.repeat(300),
    ]) {
      expect(isGraphqlTypeRef(t), t).toBe(false);
    }
  });
});

describe('isGraphqlSelectionSet', () => {
  it('accepts flat and nested selection sets as the extractors emit them', () => {
    for (const s of ['id', 'id name email', '__typename', 'id author { id name }', 'a { b { c } } d']) {
      expect(isGraphqlSelectionSet(s), s).toBe(true);
    }
  });

  it('rejects the selection breakout that appends a second operation', () => {
    expect(isGraphqlSelectionSet('id } query pwn { adminTokens')).toBe(false);
  });

  it('rejects arguments, aliases, directives, fragments and literals', () => {
    for (const s of [
      '',
      'user(id: 1)',
      'alias: id',
      'id @include(if: true)',
      '...UserFields',
      'id "str"',
      'id # comment',
      'id { }',
      '{ id }', // a block with no field to qualify
      'id }',
      'id {',
      'a { b',
      '1id',
      'a'.repeat(70_000),
    ]) {
      expect(isGraphqlSelectionSet(s), s).toBe(false);
    }
  });

  it('rejects selections nested past the depth cap', () => {
    const deep = 'a ' + '{ b '.repeat(20) + '}'.repeat(20);
    expect(isGraphqlSelectionSet(deep)).toBe(false);
  });
});
