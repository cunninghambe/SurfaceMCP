import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { extractExpressRoutes } from '../../src/extract/express/static.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, 'src');

type MustDiscover = {
  routes: string[];
  mustNotContain?: string[];
};

const manifest: MustDiscover = JSON.parse(
  readFileSync(resolve(__dirname, 'MUST_DISCOVER.json'), 'utf-8')
);

describe('express-app-mounted fixture', () => {
  it('discovers all required routes and no forbidden routes', async () => {
    const tools = await extractExpressRoutes(fixtureDir);
    const surfaced = tools.map((t) => `${t.method} ${t.path}`);

    for (const expected of manifest.routes) {
      expect(surfaced, `Missing required route: ${expected}`).toContain(expected);
    }

    for (const forbidden of manifest.mustNotContain ?? []) {
      expect(surfaced, `Forbidden route present: ${forbidden}`).not.toContain(forbidden);
    }
  });
});
