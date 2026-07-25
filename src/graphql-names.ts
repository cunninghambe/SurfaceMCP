// Grammar guards for the GraphQL fragments SurfaceMCP concatenates into an
// operation string (`src/server/graphql-request.ts`).
//
// #gql-injection: caller input reaches a GraphQL endpoint as `variables`, which is
// injection-safe. The operation TEXT, however, is built from descriptor fields
// (`field`, `args[].name`, `args[].gqlType`, `selection`) that originate in the
// TARGET project. Schema-first descriptors come from the `graphql` library and are
// therefore already constrained to valid GraphQL names, but code-first descriptors
// are read from arbitrary string literals in decorators (`@Query({ name: '…' })`,
// `@Arg('…')`) and from a hand-rolled TS→GraphQL type mapping. A crafted literal
// such as `me { password } query evil` splices a second operation into the emitted
// document. These validators are the defense-in-depth boundary: anything that is
// not a plain GraphQL name / type reference / selection set is refused, never
// emitted.
//
// Spec references are to the GraphQL June 2018 spec.

/** GraphQL `Name` production (§2.1.9). Deliberately ASCII-only, like the spec. */
export const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Hard caps so a hostile descriptor cannot produce an unbounded operation string. */
const MAX_TYPE_LENGTH = 256;
const MAX_SELECTION_LENGTH = 64 * 1024;
const MAX_SELECTION_DEPTH = 16;

/** True when `value` is a bare GraphQL `Name`: `[_A-Za-z][_0-9A-Za-z]*`. */
export function isGraphqlName(value: unknown): value is string {
  return typeof value === 'string' && GRAPHQL_NAME_RE.test(value);
}

/**
 * True when `value` is a GraphQL `Type` reference built only from names, list
 * brackets and non-null markers (§2.11):
 *
 *   Type     := NamedType | ListType | Type '!'
 *   ListType := '[' Type ']'
 *
 * Accepts `ID!`, `[String!]!`, `NewUserInput`. Rejects anything carrying
 * parentheses, braces, directives, default values, commas or whitespace — i.e.
 * every character a breakout would need.
 */
export function isGraphqlTypeRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_TYPE_LENGTH) return false;
  const end = parseTypeRef(value, 0);
  return end === value.length;
}

/** Parse one Type at `i`; returns the index just past it, or -1 on a parse failure. */
function parseTypeRef(s: string, i: number): number {
  let pos: number;
  if (s[i] === '[') {
    const inner = parseTypeRef(s, i + 1);
    if (inner === -1 || s[inner] !== ']') return -1;
    pos = inner + 1;
  } else {
    let j = i;
    while (j < s.length && /[_0-9A-Za-z]/.test(s[j]!)) j++;
    if (j === i) return -1;
    if (!GRAPHQL_NAME_RE.test(s.slice(i, j))) return -1; // leading digit
    pos = j;
  }
  if (s[pos] === '!') pos++;
  return pos;
}

/**
 * True when `value` is a selection set body containing only field names and
 * nested `{ … }` blocks, e.g. `id name author { id name }`.
 *
 * Deliberately narrow — this is exactly the shape both extractors generate. Field
 * arguments, aliases, directives, fragments, spreads, string literals and comments
 * are all refused, because none of them are ever produced by `expandObject` /
 * `expandObjectClass` and each is a viable breakout primitive.
 */
export function isGraphqlSelectionSet(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_SELECTION_LENGTH) return false;

  let i = 0;
  let depth = 0;
  let fieldsAtDepth = 0;
  let sawNameBefore = false;

  while (i < value.length) {
    const ch = value[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '{') {
      // A block must qualify a preceding field name and must not nest forever.
      if (!sawNameBefore) return false;
      if (++depth > MAX_SELECTION_DEPTH) return false;
      fieldsAtDepth = 0;
      sawNameBefore = false;
      i++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) return false; // unbalanced / early close
      if (fieldsAtDepth === 0) return false; // `{ }` is invalid GraphQL
      depth--;
      fieldsAtDepth = 1; // the block we just closed counts as its parent's field
      sawNameBefore = false;
      i++;
      continue;
    }
    let j = i;
    while (j < value.length && /[_0-9A-Za-z]/.test(value[j]!)) j++;
    if (j === i) return false; // some other character — refuse
    if (!GRAPHQL_NAME_RE.test(value.slice(i, j))) return false;
    fieldsAtDepth++;
    sawNameBefore = true;
    i = j;
  }

  return depth === 0 && fieldsAtDepth > 0;
}
