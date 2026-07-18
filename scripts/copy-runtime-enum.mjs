#!/usr/bin/env node
// Copies the hand-authored *.runtime.js helpers (injected into target apps at
// route-enumeration time) into dist/. These are plain JS and are deliberately
// excluded from the tsc pipeline, so the build must copy them verbatim.
// Cross-platform replacement for the old `mkdir -p && cp` shell one-liner,
// which failed under PowerShell/cmd on Windows.
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, '..', 'src', 'runtime-enum');
const outDir = join(root, '..', 'dist', 'runtime-enum');

await mkdir(outDir, { recursive: true });
const entries = await readdir(srcDir);
const runtimeFiles = entries.filter((f) => f.endsWith('.runtime.js'));

for (const file of runtimeFiles) {
  await copyFile(join(srcDir, file), join(outDir, file));
}

console.log(`copied ${runtimeFiles.length} runtime-enum file(s) to dist/runtime-enum/`);
