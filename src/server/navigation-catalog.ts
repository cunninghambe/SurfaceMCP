import type { Navigation, NavigationCatalog, SurfaceRuntime } from '../types.js';
import { extractNavigationsForStack } from '../extract/navigations/index.js';
import { log } from '../log.js';

const CONFIDENCE_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };
const PREFERRED_RANK: Record<string, number> = { testId: 3, ariaLabel: 2, text: 1, title: 0 };

/**
 * Sorts navigations for catalog response.
 * Primary: confidence desc. Secondary: siblingNavigations asc.
 * Tertiary: preferred desc. Quaternary: sourceFile asc, sourceLine asc.
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

export async function regenerateNavigationCatalog(runtime: SurfaceRuntime, root: string): Promise<void> {
  const { surface } = runtime;
  try {
    const { navigations, skips } = await extractNavigationsForStack(surface.stack, root);
    runtime.navigationCatalog = {
      revision: runtime.navigationCatalog.revision + 1,
      navigations: sortNavigations(navigations),
      skips,
    };
    if (skips.length > 0) {
      log.info({ surface: surface.name, count: skips.length }, 'navigation extraction skips');
    }
    log.info({ surface: surface.name, revision: runtime.navigationCatalog.revision, count: navigations.length }, 'navigation catalog updated');
  } catch (err) {
    log.error({ surface: surface.name, err }, 'navigation extraction error — navigation catalog unchanged');
  }
}

// ─── Legacy single accessor (for back-compat with http.ts meta-tools) ─────────

let _legacyNavigationCatalog: NavigationCatalog = { revision: 0, navigations: [], skips: [] };

export function setNavigationCatalog(c: NavigationCatalog): void { _legacyNavigationCatalog = c; }
export function getNavigationCatalog(): NavigationCatalog { return _legacyNavigationCatalog; }
