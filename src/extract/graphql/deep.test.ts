import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parse } from 'graphql';
import { extractGraphqlSchema, DEFAULT_SELECTION_DEPTH } from './parse.js';
import { buildGraphqlOperation } from '../../server/graphql-request.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const root = resolve(FIXTURES, 'graphql-deep-app');

describe('graphql deep selection sets', () => {
  it('defaults the expansion depth to 3 object levels', () => {
    expect(DEFAULT_SELECTION_DEPTH).toBe(3);
  });

  it('expands nested object return types up to the bounded depth', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    const org = tools.find((t) => t.name === 'query_org');
    // Organization -> Person -> Address expand (3 levels); Country (level 4) truncates.
    expect(org!.graphql?.selection).toBe(
      'id name ceo { id name address { street city } }',
    );
  });

  it('builds a matching nested outputSchema and truncates past the depth limit', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    const org = tools.find((t) => t.name === 'query_org');
    const ceo = org!.outputSchema?.properties?.ceo;
    expect(ceo?.type).toBe('object');
    const address = ceo?.properties?.address;
    expect(address?.type).toBe('object');
    expect(address?.properties?.street).toMatchObject({ type: 'string' });
    // Country is one level past the limit: opaque object marker, no properties.
    const country = address?.properties?.country;
    expect(country).toEqual({ type: 'object' });
  });

  it('terminates on a self-referential type, keeping only its scalar leaves', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    const emp = tools.find((t) => t.name === 'query_employee');
    // `manager` (Employee) and `reports` ([Employee]) are cycles → not selected.
    expect(emp!.graphql?.selection).toBe('id name');
    // The cyclic fields survive in the schema as opaque markers.
    expect(emp!.outputSchema?.properties?.manager).toEqual({ type: 'object' });
    expect(emp!.outputSchema?.properties?.reports).toEqual({ type: 'array', items: { type: 'object' } });
  });

  it('emits deep + cyclic selections that still parse as valid GraphQL documents', () => {
    const tools = extractGraphqlSchema(root, '/graphql');
    for (const name of ['query_org', 'query_employee']) {
      const tool = tools.find((t) => t.name === name)!;
      const op = buildGraphqlOperation(tool.graphql!);
      expect(() => parse(op), `${name}: ${op}`).not.toThrow();
    }
    // Spot-check the exact deep operation string.
    const org = tools.find((t) => t.name === 'query_org')!;
    expect(buildGraphqlOperation(org.graphql!)).toBe(
      'query org { org { id name ceo { id name address { street city } } } }',
    );
  });
});
