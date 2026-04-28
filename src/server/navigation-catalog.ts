import type { Navigation, NavigationCatalog, SurfaceConfig } from '../types.js';
import { extractNavigationsForStack } from '../extract/navigations/index.js';
import { log } from '../log.js';

let navigationCatalog: NavigationCatalog = { revision: 0, navigations: [], skips: [] };

export function getNavigationCatalog(): NavigationCatalog {
  return navigationCatalog;
}

const CONFIDENCE_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };
const PREFERRED_RANK: Record<string, number> = { testId: 3, ariaLabel: 2, text: 1, title: 0 };

/**
 * Sorts navigations for catalog response.
 * Primary: confidence desc (high first).
 * Secondary: siblingNavigations asc (unique-text wins).
 * Tertiary: preferred desc (testId > ariaLabel > text > title > undefined).
 * Quaternary: sourceFile asc, sourceLine asc.
 */
function sortNavigations(navs: Navigation[]): Navigation[] {
  return [...navs].sort((a, b) => {
    const confDiff = (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
    if (confDiff !== 0) return confDiff;

    const sibDiff = (a.siblingNavigations ?? 0) - (b.siblingNavigations ?? 0);
    if (sibDiff !== 0) return sibDiff;

    const prefDiff =
      (PREFERRED_RANK[b.triggerSelectorHint.preferred ?? ''] ?? -1) -
      (PREFERRED_RANK[a.triggerSelectorHint.preferred ?? ''] ?? -1);
    if (prefDiff !== 0) return prefDiff;

    if (a.sourceFile < b.sourceFile) return -1;
    if (a.sourceFile > b.sourceFile) return 1;
    return a.sourceLine - b.sourceLine;
  });
}

export async function regenerateNavigationCatalog(surface: SurfaceConfig, root: string): Promise<void> {
  try {
    const { navigations, skips } = await extractNavigationsForStack(surface.stack, root);
    navigationCatalog = {
      revision: navigationCatalog.revision + 1,
      navigations: sortNavigations(navigations),
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
