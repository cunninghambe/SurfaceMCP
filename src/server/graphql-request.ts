import type { GraphQLToolDescriptor } from '../types.js';

/**
 * Synthesize the GraphQL operation string for a tool descriptor. The caller's input
 * is passed as GraphQL `variables`, so the operation only ever references `$var`s —
 * no value interpolation into the query text (which keeps it injection-free).
 *
 * Shape: `<opType> <field>(<$var decls>) { <field>(<arg: $var>) <selection> }`
 * where each clause is omitted when empty (no args → no parens; scalar return → no
 * selection block).
 *
 * Example — `query { user(id: ID!): User }` with selection `id name email`:
 *   query user($id: ID!) { user(id: $id) { id name email } }
 */
export function buildGraphqlOperation(desc: GraphQLToolDescriptor): string {
  const varDecls = desc.args.length
    ? `(${desc.args.map((a) => `$${a.name}: ${a.gqlType}`).join(', ')})`
    : '';
  const argList = desc.args.length
    ? `(${desc.args.map((a) => `${a.name}: $${a.name}`).join(', ')})`
    : '';
  const selection = desc.selection ? ` { ${desc.selection} }` : '';
  return `${desc.operationType} ${desc.field}${varDecls} { ${desc.field}${argList}${selection} }`;
}

/** Serialize the `{ query, variables }` POST body a GraphQL endpoint expects. */
export function buildGraphqlBody(desc: GraphQLToolDescriptor, input: Record<string, unknown>): string {
  return JSON.stringify({ query: buildGraphqlOperation(desc), variables: input ?? {} });
}
