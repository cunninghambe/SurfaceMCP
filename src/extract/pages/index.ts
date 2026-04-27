import type { Page, PageSkip, Stack } from '../../types.js';
import { extractVitePages } from '../vite/router.js';

export type PageExtractor = (root: string) => Promise<{ pages: Page[]; skips: PageSkip[] }>;

const REGISTRY: Partial<Record<Stack, PageExtractor>> = {
  vite: extractVitePages,
};

export async function extractPagesForStack(
  stack: Stack,
  root: string
): Promise<{ pages: Page[]; skips: PageSkip[] }> {
  const fn = REGISTRY[stack];
  if (!fn) return { pages: [], skips: [] };
  return fn(root);
}
