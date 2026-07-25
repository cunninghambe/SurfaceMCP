import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';

const CreatePostInput = z.object({
  title: z.string().min(1).max(120),
  body: z.string(),
  published: z.boolean().optional(),
});

const PostSummary = z.object({
  id: z.string(),
  title: z.string(),
});

// A sub-router composed into appRouter by name from another file.
export const postRouter = router({
  // No .input() — statically proven to take no input.
  list: publicProcedure.query(() => []),

  // Inline z.object() input.
  byId: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ input }) => ({ id: input.id, title: 'stub' })),

  // Input AND output schemas, both by identifier reference.
  create: publicProcedure
    .input(CreatePostInput)
    .output(PostSummary)
    .mutation(({ input }) => ({ id: '1', title: input.title })),
});
