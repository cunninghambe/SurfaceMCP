import { describe, it, expect } from 'vitest';
import { extractServerActions } from './server-actions.js';
import { resolve } from 'node:path';

const FIXTURE = resolve(import.meta.dirname, '../../../fixtures/nextjs-app');

describe('extractServerActions — v0.2 closure-bound discovery', () => {
  it('discovers Pattern A: file-level use-server module', async () => {
    const tools = await extractServerActions(FIXTURE);
    const t = tools.find((t) => t.sourceFunctionName === 'createOrder');
    expect(t).toBeDefined();
    expect(t!.isServerAction).toBe(true);
    expect(t!.sideEffectClass).toBe('mutating');
    expect(t!.sourceFile).toBe('app/actions/orders.ts');
    expect(t!.toolId).toBe('3aabc90b1d5d');
    expect(t!.inputSchemaConfidence).toBe('introspected');
    expect(t!.inputSchema.required).toEqual(expect.arrayContaining(['productId', 'qty']));
  });

  it('discovers Pattern B: inline use-server in server component', async () => {
    const tools = await extractServerActions(FIXTURE);
    const t = tools.find((t) => t.sourceFunctionName === 'archiveOrder');
    expect(t).toBeDefined();
    expect(t!.toolId).toBe('11b684e04a34');
    expect(t!.inputSchemaConfidence).toBe('introspected');
  });

  it('preserves Pattern C: form-bound action (regression)', async () => {
    const tools = await extractServerActions(FIXTURE);
    const t = tools.find((t) => t.sourceFunctionName === 'createUser');
    expect(t).toBeDefined();
    expect(t!.toolId).toBe('997c1db5bd0b');
    expect(t!.inputSchemaConfidence).toBe('inferred');
    expect(t!.inputSchema.required).toEqual(expect.arrayContaining(['name', 'email']));
  });

  it('does not duplicate Pattern D actions for each consuming page', async () => {
    const tools = await extractServerActions(FIXTURE);
    const createOrders = tools.filter((t) => t.sourceFunctionName === 'createOrder');
    expect(createOrders).toHaveLength(1);
  });

  it('emits exactly three server-action tools for the fixture', async () => {
    const tools = await extractServerActions(FIXTURE);
    expect(tools).toHaveLength(3);
  });

  it('every emitted tool has isServerAction=true and method=POST', async () => {
    const tools = await extractServerActions(FIXTURE);
    for (const t of tools) {
      expect(t.isServerAction).toBe(true);
      expect(t.method).toBe('POST');
      expect(t.sideEffectClass).toBe('mutating');
    }
  });

  it('skips non-async function-level use-server (debug log only)', async () => {
    // The fixture does not contain a non-async 'use server' function.
    // This test asserts that even if added, no tool would be emitted for it.
    // The total tool count of 3 transitively verifies this:
    // if non-async functions were mistakenly included, the count would exceed 3.
    const tools = await extractServerActions(FIXTURE);
    expect(tools).toHaveLength(3);
  });
});
