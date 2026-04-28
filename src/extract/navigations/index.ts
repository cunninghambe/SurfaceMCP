import type { Navigation, NavigationSkip, Stack } from '../../types.js';
import { extractViteNavigations } from '../vite/navigations.js';

export type NavigationExtractor = (root: string) => Promise<{ navigations: Navigation[]; skips: NavigationSkip[] }>;

const REGISTRY: Partial<Record<Stack, NavigationExtractor>> = {
  vite: extractViteNavigations,
};

export async function extractNavigationsForStack(
  stack: Stack,
  root: string
): Promise<{ navigations: Navigation[]; skips: NavigationSkip[] }> {
  const fn = REGISTRY[stack];
  if (!fn) return { navigations: [], skips: [] };
  return fn(root);
}
