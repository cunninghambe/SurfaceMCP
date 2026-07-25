// Security fixture (#gql-injection). Every decorator literal below is a GraphQL
// breakout attempt smuggled through the values the code-first extractor reads from
// target source. Discovery must refuse each of them and still find `safeQuery`.
//
// This file is never executed — the extractor only parses it with ts-morph.
import 'reflect-metadata';
import { ObjectType, Field, Resolver, Query, Mutation, Arg } from 'type-graphql';

@ObjectType()
export class Account {
  @Field()
  id!: string;

  // A string-literal property name that closes the selection set and opens a
  // second operation. Must not be emitted into any selection.
  @Field()
  'stolen } query leak { adminTokens'!: string;
}

@Resolver(() => Account)
export class HostileResolver {
  // Baseline: a clean operation in the same file must still be discovered.
  @Query(() => String)
  safeQuery(@Arg('id') id: string): string {
    return id;
  }

  // Breakout via the @Query `name` option — becomes `desc.field`.
  @Query(() => String, { name: 'stolen { password } query leak' })
  renamed(): string {
    return '';
  }

  // Breakout via the @Arg name literal — becomes `desc.args[].name`.
  @Query(() => String)
  badArgName(@Arg('a) { stolen } query leak(') a: string): string {
    return a;
  }

  // Breakout attempt via the mapped GraphQL type — becomes `desc.args[].gqlType`.
  // `tsTypeToGql` already clamps this to the first bare identifier (`String`), so
  // this documents that the mapping is not the weak link; `isGraphqlTypeRef` is
  // the backstop for any future mapping that is less careful.
  @Mutation(() => String)
  badArgType(@Arg('id') id: 'String!) { stolen } query leak($z: String'): string {
    return id;
  }

  // Exercises the SELECTION path: expanding Account must drop the hostile
  // string-literal property name and emit only `id`.
  @Query(() => [Account])
  accounts(): Account[] {
    return [];
  }

  // Punctuation-free but still not a GraphQL Name (`$` is legal in TS only).
  @Query(() => String, { name: 'dollar$name' })
  dollarName(): string {
    return '';
  }
}
