import { describe, it, expect } from 'vitest';
import { classifyByCallGraph } from './call-graph.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('side-effect classification', () => {
  it('classifies GET as safe', () => {
    expect(classifyByCallGraph('src/api.ts', '/tmp', 'GET', [])).toBe('safe');
  });

  it('classifies HEAD as safe', () => {
    expect(classifyByCallGraph('src/api.ts', '/tmp', 'HEAD', [])).toBe('safe');
  });

  it('classifies POST as mutating (default)', () => {
    expect(classifyByCallGraph('nonexistent.ts', '/tmp', 'POST', [])).toBe('mutating');
  });

  it('classifies handler that directly imports stripe as external', () => {
    const tmp = resolve(tmpdir(), `surface-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const handler = resolve(tmp, 'handler.ts');
    writeFileSync(handler, `import Stripe from 'stripe';\nexport async function POST() {}`);

    try {
      const result = classifyByCallGraph('handler.ts', tmp, 'POST', []);
      expect(result).toBe('external');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('classifies handler that imports helper which imports stripe as mutating (conservative one-hop)', () => {
    const tmp = resolve(tmpdir(), `surface-test-${Date.now()}`);
    mkdirSync(resolve(tmp, 'lib'), { recursive: true });

    const handler = resolve(tmp, 'handler.ts');
    const helper = resolve(tmp, 'lib', 'payments.ts');

    writeFileSync(handler, `import { charge } from './lib/payments';\nexport async function POST() {}`);
    writeFileSync(helper, `import Stripe from 'stripe';\nexport function charge() {}`);

    try {
      const result = classifyByCallGraph('handler.ts', tmp, 'POST', []);
      // One-hop: handler imports helper which imports stripe → conservative = mutating
      expect(result).toBe('mutating');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});
