import 'reflect-metadata';
import { ObjectType, InputType, Field, ID, Int, Resolver, Query, Mutation, Arg } from 'type-graphql';

@ObjectType()
export class Rating {
  @Field(() => Int)
  stars!: number;

  @Field({ nullable: true })
  comment?: string;
}

@ObjectType()
export class Recipe {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ nullable: true })
  description?: string;

  // Nested @ObjectType, exercised by the bounded-depth output expansion.
  @Field(() => [Rating])
  ratings!: Rating[];
}

@InputType()
export class NewRecipeInput {
  @Field()
  title!: string;

  @Field({ nullable: true })
  description?: string;
}

@Resolver(() => Recipe)
export class RecipeResolver {
  @Query(() => [Recipe])
  recipes(): Recipe[] {
    return [];
  }

  @Query(() => Recipe, { nullable: true })
  recipe(@Arg('id', () => ID) id: string): Recipe | undefined {
    void id;
    return undefined;
  }

  @Mutation(() => Recipe)
  addRecipe(@Arg('input') input: NewRecipeInput): Recipe {
    return { id: '1', title: input.title, ratings: [] } as Recipe;
  }
}
