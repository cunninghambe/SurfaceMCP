import { describe, it, expect } from 'vitest';
import { isReadOnlyBlocked, redactHeaders, CallLimiter } from './rails.js';

describe('isReadOnlyBlocked', () => {
  it('permits safe tools and blocks mutating/external when readOnly', () => {
    expect(isReadOnlyBlocked({ sideEffectClass: 'safe' }, true)).toBe(false);
    expect(isReadOnlyBlocked({ sideEffectClass: 'mutating' }, true)).toBe(true);
    expect(isReadOnlyBlocked({ sideEffectClass: 'external' }, true)).toBe(true);
  });

  it('blocks nothing when readOnly is off', () => {
    for (const c of ['safe', 'mutating', 'external'] as const) {
      expect(isReadOnlyBlocked({ sideEffectClass: c }, false)).toBe(false);
    }
  });
});

describe('redactHeaders', () => {
  it('masks credential-bearing headers but keeps their names', () => {
    const out = redactHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer supersecret',
      Cookie: 'session=abc123',
      'X-Api-Key': 'k-123',
      'X-Auth-Token': 't-123',
    });
    expect(out['Content-Type']).toBe('application/json');
    expect(out.Authorization).toBe('<redacted>');
    expect(out.Cookie).toBe('<redacted>');
    expect(out['X-Api-Key']).toBe('<redacted>');
    expect(out['X-Auth-Token']).toBe('<redacted>');
    // Names are preserved so a caller can see auth *would* be attached.
    expect(Object.keys(out).sort()).toEqual(
      ['Authorization', 'Content-Type', 'Cookie', 'X-Api-Key', 'X-Auth-Token'].sort()
    );
  });

  it('is case-insensitive on header names', () => {
    expect(redactHeaders({ authorization: 'x', cookie: 'y' })).toEqual({
      authorization: '<redacted>',
      cookie: '<redacted>',
    });
  });

  it('never leaks a secret value anywhere in the output', () => {
    const out = JSON.stringify(redactHeaders({ Authorization: 'Bearer TOPSECRET' }));
    expect(out).not.toContain('TOPSECRET');
  });
});

describe('CallLimiter', () => {
  it('is a no-op passthrough when unconfigured', async () => {
    const l = new CallLimiter({});
    expect(l.unbounded).toBe(true);
    const release = await l.acquire();
    release();
  });

  it('bounds concurrency to maxConcurrent', async () => {
    const l = new CallLimiter({ maxConcurrent: 2 });
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const release = await l.acquire();
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        release();
      })
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(live).toBe(0);
  });

  it('releases the slot even when the caller throws', async () => {
    const l = new CallLimiter({ maxConcurrent: 1 });
    const release = await l.acquire();
    try {
      throw new Error('boom');
    } catch {
      release();
    }
    // A second acquire must not deadlock.
    const second = await l.acquire();
    second();
  });

  it('double-release does not free a phantom slot', async () => {
    const l = new CallLimiter({ maxConcurrent: 1 });
    const release = await l.acquire();
    release();
    release(); // idempotent

    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const r = await l.acquire();
        live++;
        peak = Math.max(peak, live);
        await new Promise((res) => setTimeout(res, 2));
        live--;
        r();
      })
    );
    expect(peak).toBe(1);
  });

  it('throttles to the configured rate using an injected clock', async () => {
    // Virtual clock: the bucket starts full (2), so calls 3+ must wait for refill.
    let now = 0;
    const l = new CallLimiter({ requestsPerSecond: 2 }, () => now);

    const r1 = await l.acquire(); r1();
    const r2 = await l.acquire(); r2();
    // Bucket is now empty; advancing 500ms at 2 rps mints exactly one token.
    now += 500;
    const r3 = await l.acquire(); r3();

    // Without advancing further there is no token: this acquire must stay pending.
    let granted = false;
    void l.acquire().then((rel) => { granted = true; rel(); });
    await new Promise((r) => setTimeout(r, 20));
    expect(granted).toBe(false);
  });
});
