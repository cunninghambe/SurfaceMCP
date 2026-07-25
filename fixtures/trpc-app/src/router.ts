import { z } from 'zod';
import { publicProcedure, router } from './trpc.js';
import { postRouter } from './routers/post.js';
import { SearchInput } from './schemas.js';

export const appRouter = router({
  // Top-level procedure, no input.
  health: publicProcedure.query(() => 'ok'),

  // Input schema imported from another module — out of reach of the file-scoped
  // static zod reader, so this one lands on inputSchemaConfidence: 'unknown'.
  search: publicProcedure.input(SearchInput).query(({ input }) => [input.q]),

  // Sub-router referenced by name, declared in another file.
  post: postRouter,

  // Inline nested sub-router.
  user: router({
    byEmail: publicProcedure
      .input(z.object({ email: z.string().email() }))
      .query(({ input }) => ({ email: input.email })),
  }),

  // Subscriptions are out of scope — must NOT surface as a tool.
  onPostAdded: publicProcedure.subscription(() => null),
});

export type AppRouter = typeof appRouter;
