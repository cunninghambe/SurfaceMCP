import { z } from 'zod';

// Deliberately declared in its own module: the shared static zod reader is
// file-scoped, so a procedure that references this by import cannot resolve it.
export const SearchInput = z.object({
  q: z.string().min(2),
});
