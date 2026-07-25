import type { GraphQLToolDescriptor } from '../types.js';
import { isGraphqlName, isGraphqlTypeRef, isGraphqlSelectionSet } from '../graphql-names.js';

/**
 * Thrown when a descriptor cannot be turned into an operation without emitting
 * text that would change the operation's meaning. Callers surface this as a tool
 * error rather than sending a request built from unvalidated fragments.
 */
export class GraphqlDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphqlDescriptorError';
  }
}

/**
 * Synthesize the GraphQL operation string for a tool descriptor. The caller's input
 * is passed as GraphQL `variables`, so the operation only ever references `$var`s —
 * no value interpolation into the query text.
 *
 * #gql-injection: the operation TEXT is still concatenated from descriptor fields
 * that originate in the target project (SDL for schema-first, decorator string
 * literals for code-first). Every fragment is therefore re-validated here against
 * the GraphQL name / type / selection grammars before it is emitted — a crafted
 * `@Query({ name: 'me { password } query evil' })` or an `@Arg` type of
 * `String!) { adminSecrets } query x($z: String` would otherwise splice a second
 * operation into the document we send with an authenticated role session.
 * The extractors reject the same shapes at discovery time; this is the backstop
 * that also covers a hand-written or persisted catalog.
 *
 * Shape: `<opType> <field>(<$var decls>) { <field>(<arg: $var>) <selection> }`
 * where each clause is omitted when empty (no args → no parens; scalar return → no
 * selection block).
 *
 * Example — `query { user(id: ID!): User }` with selection `id name email`:
 *   query user($id: ID!) { user(id: $id) { id name email } }
 *
 * @throws {GraphqlDescriptorError} when the operation type, field name, or any
 * argument name/type fails validation.
 */
export function buildGraphqlOperation(desc: GraphQLToolDescriptor): string {
  if (desc.operationType !== 'query' && desc.operationType !== 'mutation') {
    throw new GraphqlDescriptorError(`Unsupported GraphQL operation type: ${String(desc.operationType)}`);
  }
  if (!isGraphqlName(desc.field)) {
    throw new GraphqlDescriptorError(`Invalid GraphQL field name: ${JSON.stringify(desc.field)}`);
  }
  for (const a of desc.args) {
    if (!isGraphqlName(a.name)) {
      throw new GraphqlDescriptorError(`Invalid GraphQL argument name: ${JSON.stringify(a.name)}`);
    }
    if (!isGraphqlTypeRef(a.gqlType)) {
      throw new GraphqlDescriptorError(
        `Invalid GraphQL type for argument "${a.name}": ${JSON.stringify(a.gqlType)}`
      );
    }
  }

  const varDecls = desc.args.length
    ? `(${desc.args.map((a) => `$${a.name}: ${a.gqlType}`).join(', ')})`
    : '';
  const argList = desc.args.length
    ? `(${desc.args.map((a) => `${a.name}: $${a.name}`).join(', ')})`
    : '';
  // An unusable selection degrades to `__typename` (always valid, discloses only the
  // type name) rather than failing the whole call or emitting the raw string.
  const selection = desc.selection
    ? ` { ${isGraphqlSelectionSet(desc.selection) ? desc.selection : '__typename'} }`
    : '';
  return `${desc.operationType} ${desc.field}${varDecls} { ${desc.field}${argList}${selection} }`;
}

/**
 * Serialize the `{ query, variables }` POST body a GraphQL endpoint expects.
 *
 * @throws {GraphqlDescriptorError} see {@link buildGraphqlOperation}.
 */
export function buildGraphqlBody(desc: GraphQLToolDescriptor, input: Record<string, unknown>): string {
  return JSON.stringify({ query: buildGraphqlOperation(desc), variables: input ?? {} });
}
