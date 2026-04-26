import chokidar, { type FSWatcher } from 'chokidar';
import { debounce } from './debounce.js';

const DEFAULT_IGNORE = [
  '**/.next/**',
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__pycache__/**',
  '**/*.log',
  '**/.bughunter/**',
  '**/.surfacemcp/**',
  '**/.gitnexus/**',
  '**/.vercel/**',
  '**/coverage/**',
];

const DEBOUNCE_MS = 1500;

export type WatcherOptions = {
  watchPaths: string[];
  extraIgnore?: string[];
  onRegen: () => void;
};

export function startWatcher(opts: WatcherOptions): FSWatcher {
  const ignored = [...DEFAULT_IGNORE, ...(opts.extraIgnore ?? [])];

  const debouncedRegen = debounce(opts.onRegen, DEBOUNCE_MS);

  const watcher = chokidar.watch(opts.watchPaths, {
    ignored,
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on('add', debouncedRegen);
  watcher.on('change', debouncedRegen);
  watcher.on('unlink', debouncedRegen);

  return watcher;
}
