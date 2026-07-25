import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSnapshot, stableJson, type SurfaceSnapshot } from '../diff/snapshot.js';
import { diffCatalogs, formatDiffSummary } from '../diff/surface-diff.js';
import { extractLiveSnapshot } from './snapshot.js';

export type DiffOptions = {
  projectRoot?: string;
  surface?: string;
  before?: string;
  after?: string;
  out?: string;
  failOnBreaking?: boolean;
};

/** Read + parse a snapshot file, exiting with a readable message on failure. */
function loadSnapshotFile(projectRoot: string, file: string, label: string): SurfaceSnapshot {
  const path = resolve(projectRoot, file);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    console.error(`Cannot read ${label} snapshot: ${path}`);
    process.exit(1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    console.error(`${label} snapshot is not valid JSON (${path}): ${String(err)}`);
    process.exit(1);
  }

  const parsed = parseSnapshot(parsedJson, `${label} snapshot (${path})`);
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exit(1);
  }
  return parsed.snapshot;
}

/**
 * Diff two surface snapshots, or a stored snapshot against a freshly-extracted
 * live catalog when --after is omitted.
 *
 * Machine-readable JSON goes to stdout (or --out); the human summary goes to
 * stderr, so `surfacemcp diff ... | jq` stays clean. With --fail-on-breaking the
 * process exits 1 when any breaking change is detected — the CI gate.
 */
export async function runDiff(opts: DiffOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());

  if (!opts.before) {
    console.error('Usage: surfacemcp diff --before=<snapshot.json> [--after=<snapshot.json>] [--out=<file>] [--fail-on-breaking]');
    process.exit(1);
  }

  const before = loadSnapshotFile(projectRoot, opts.before, 'before');
  const after = opts.after
    ? loadSnapshotFile(projectRoot, opts.after, 'after')
    : await extractLiveSnapshot({ projectRoot: opts.projectRoot, surface: opts.surface });

  const diff = diffCatalogs(before.tools, after.tools);
  const payload = {
    before: { surface: before.surface, revision: before.revision, toolCount: before.tools.length },
    after: { surface: after.surface, revision: after.revision, toolCount: after.tools.length },
    ...diff,
  };
  const json = stableJson(payload);

  if (before.surface && after.surface && before.surface !== after.surface) {
    console.error(
      `Note: comparing snapshots from different surfaces ("${before.surface}" vs "${after.surface}") — toolIds are surface-scoped, so everything will look added/removed.`
    );
  }

  console.error(formatDiffSummary(diff));

  if (opts.out) {
    const outPath = resolve(projectRoot, opts.out);
    writeFileSync(outPath, json);
    console.error(`Wrote diff to ${outPath}`);
  } else {
    process.stdout.write(json);
  }

  if (opts.failOnBreaking && diff.summary.breakingTools > 0) {
    process.exit(1);
  }
}
