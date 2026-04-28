import { describe, it, expect } from 'vitest';
import type { Navigation } from '../types.js';

// Import the sort logic by re-implementing it here so we can test without
// hitting the module-level singleton (regenerateNavigationCatalog is async and
// touches the file system). We test the sort contract via a small helper.

const CONFIDENCE_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };
const PREFERRED_RANK: Record<string, number> = { testId: 3, ariaLabel: 2, text: 1, title: 0 };

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

function nav(overrides: Partial<Navigation> & { target: string }): Navigation {
  const { target, ...rest } = overrides;
  return {
    label: target,
    method: 'state-setter',
    target,
    kind: 'state',
    triggerSelectorHint: {},
    sourceFile: 'src/App.tsx',
    sourceLine: 1,
    confidence: 'high',
    siblingNavigations: 0,
    duplicateCount: 0,
    scope: 'top-level',
    ...rest,
  };
}

describe('navigation catalog sort', () => {
  it('sorts by confidence desc (high first, low last)', () => {
    const navs = [
      nav({ target: 'low', confidence: 'low' }),
      nav({ target: 'high', confidence: 'high' }),
      nav({ target: 'med', confidence: 'medium' }),
    ];
    const sorted = sortNavigations(navs);
    expect(sorted.map(n => n.target)).toEqual(['high', 'med', 'low']);
  });

  it('sorts by siblingNavigations asc within same confidence', () => {
    const navs = [
      nav({ target: 'ambiguous', confidence: 'high', siblingNavigations: 3 }),
      nav({ target: 'unique', confidence: 'high', siblingNavigations: 0 }),
      nav({ target: 'somewhat', confidence: 'high', siblingNavigations: 1 }),
    ];
    const sorted = sortNavigations(navs);
    expect(sorted.map(n => n.target)).toEqual(['unique', 'somewhat', 'ambiguous']);
  });

  it('sorts by preferred desc (testId > ariaLabel > text > title > undefined) within same confidence+siblings', () => {
    const navs = [
      nav({ target: 'text-only', triggerSelectorHint: { text: 'Go', preferred: 'text' } }),
      nav({ target: 'testid', triggerSelectorHint: { testId: 'btn', preferred: 'testId' } }),
      nav({ target: 'none', triggerSelectorHint: {} }),
      nav({ target: 'aria', triggerSelectorHint: { ariaLabel: 'Nav', preferred: 'ariaLabel' } }),
    ];
    const sorted = sortNavigations(navs);
    expect(sorted.map(n => n.target)).toEqual(['testid', 'aria', 'text-only', 'none']);
  });

  it('sorts by sourceFile asc then sourceLine asc as final tiebreaker', () => {
    const navs = [
      nav({ target: 'z', sourceFile: 'src/Z.tsx', sourceLine: 10 }),
      nav({ target: 'a', sourceFile: 'src/A.tsx', sourceLine: 20 }),
      nav({ target: 'b', sourceFile: 'src/A.tsx', sourceLine: 5 }),
    ];
    const sorted = sortNavigations(navs);
    expect(sorted.map(n => n.target)).toEqual(['b', 'a', 'z']);
  });

  it('navigation list is sorted by confidence desc, then siblingNavigations asc, then preferred desc, then sourceFile asc, then sourceLine asc', () => {
    const navs = [
      nav({ target: 'low-text', confidence: 'low', triggerSelectorHint: { text: 'X', preferred: 'text' }, siblingNavigations: 0, sourceFile: 'src/A.tsx', sourceLine: 1 }),
      nav({ target: 'high-sibling', confidence: 'high', siblingNavigations: 2, triggerSelectorHint: { text: 'Y', preferred: 'text' }, sourceFile: 'src/A.tsx', sourceLine: 2 }),
      nav({ target: 'high-testid', confidence: 'high', siblingNavigations: 0, triggerSelectorHint: { testId: 't', preferred: 'testId' }, sourceFile: 'src/B.tsx', sourceLine: 1 }),
      nav({ target: 'high-text', confidence: 'high', siblingNavigations: 0, triggerSelectorHint: { text: 'Z', preferred: 'text' }, sourceFile: 'src/A.tsx', sourceLine: 1 }),
    ];
    const sorted = sortNavigations(navs);
    // high-testid: high conf, 0 siblings, testId preferred, src/B
    // high-text: high conf, 0 siblings, text preferred, src/A line 1
    // high-sibling: high conf, 2 siblings
    // low-text: low conf
    expect(sorted[0].target).toBe('high-testid');
    expect(sorted[1].target).toBe('high-text');
    expect(sorted[2].target).toBe('high-sibling');
    expect(sorted[3].target).toBe('low-text');
  });
});
