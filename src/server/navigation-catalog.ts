import type { NavigationCatalog, SurfaceConfig } from '../types.js';
import { extractNavigationsForStack } from '../extract/navigations/index.js';
import { log } from '../log.js';

let navigationCatalog: NavigationCatalog = { revision: 0, navigations: [], skips: [] };

export function getNavigationCatalog(): NavigationCatalog {
  return navigationCatalog;
}

export async function regenerateNavigationCatalog(surface: SurfaceConfig, root: string): Promise<void> {
  try {
    const { navigations, skips } = await extractNavigationsForStack(surface.stack, root);
    navigationCatalog = {
      revision: navigationCatalog.revision + 1,
      navigations,
      skips,
    };
    if (skips.length > 0) {
      log.info({ count: skips.length }, 'navigation extraction skips');
    }
    log.info({ revision: navigationCatalog.revision, count: navigations.length }, 'navigation catalog updated');
  } catch (err) {
    log.error({ err }, 'navigation extraction error — navigation catalog unchanged');
  }
}
