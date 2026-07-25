// Safety rails for autonomous callers.
//
// SurfaceMCP's primary consumers are agents (e.g. BugHunter) that drive a real
// app's full surface without a human in the loop. Nothing else in the call path
// bounds *what* they may invoke or *how fast*: the only pre-existing guard is the
// `external` side-effect block. These rails add three orthogonal controls:
//
//   - readOnly  — refuse anything that isn't `safe` (no mutating/external calls)
//   - dryRun    — return the exact request that WOULD be sent, without sending it
//   - throttle  — per-surface request rate + max in-flight concurrency
//
// All three default to off/unbounded, so existing behaviour is unchanged unless
// a caller or config opts in.

import type { ToolMeta } from '../types.js';

/** Per-surface rails configuration (all optional; omitted = no limit). */
export type RailsConfig = {
  /** Refuse non-`safe` tools for every call to this surface. */
  readOnly?: boolean;
  /** Max requests started per second (token bucket). */
  requestsPerSecond?: number;
  /** Max requests in flight at once. */
  maxConcurrent?: number;
};

/**
 * True when the tool must be refused because the caller (or surface) is
 * read-only. `safe` tools — GET/HEAD/OPTIONS by default classification — are
 * always permitted; `mutating` and `external` are not.
 */
export function isReadOnlyBlocked(tool: Pick<ToolMeta, 'sideEffectClass'>, readOnly: boolean): boolean {
  return readOnly && tool.sideEffectClass !== 'safe';
}

const REDACTED = '<redacted>';
/**
 * Header names whose values carry credentials. dryRun echoes the request back to
 * the caller, so these must be masked — the header NAME is retained (so the agent
 * can see auth would be attached) but never the secret itself.
 */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Mask credential-bearing header values while preserving their names. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) || /(?:api[-_]?key|token|secret)/i.test(k) ? REDACTED : v;
  }
  return out;
}

/** The request a call would have issued, with secrets masked. */
export type DryRunRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

/**
 * Token-bucket rate limiter combined with a concurrency semaphore, scoped to one
 * surface. `acquire()` resolves once a slot AND a token are available and returns
 * the release function; callers must release in a `finally`.
 *
 * Waiters are served FIFO so a burst can't starve earlier calls.
 */
export class CallLimiter {
  private readonly rps: number | undefined;
  private readonly maxConcurrent: number | undefined;
  private tokens: number;
  private lastRefill: number;
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(cfg: RailsConfig = {}, private readonly now: () => number = Date.now) {
    this.rps = cfg.requestsPerSecond && cfg.requestsPerSecond > 0 ? cfg.requestsPerSecond : undefined;
    this.maxConcurrent = cfg.maxConcurrent && cfg.maxConcurrent > 0 ? cfg.maxConcurrent : undefined;
    // Start with a full bucket so the first burst isn't penalised.
    this.tokens = this.rps ?? 0;
    this.lastRefill = this.now();
  }

  /** True when neither limit is configured — callers can skip the machinery. */
  get unbounded(): boolean {
    return this.rps === undefined && this.maxConcurrent === undefined;
  }

  private refill(): void {
    if (this.rps === undefined) return;
    const nowMs = this.now();
    const elapsedSec = (nowMs - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.rps, this.tokens + elapsedSec * this.rps);
    this.lastRefill = nowMs;
  }

  /** Milliseconds until the next token is available (0 when one is ready). */
  private msUntilToken(): number {
    if (this.rps === undefined) return 0;
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.rps) * 1000);
  }

  private canProceed(): boolean {
    if (this.maxConcurrent !== undefined && this.inFlight >= this.maxConcurrent) return false;
    return this.msUntilToken() === 0;
  }

  private take(): void {
    if (this.rps !== undefined) this.tokens -= 1;
    this.inFlight += 1;
  }

  /** Wake the next waiter if it can now proceed. */
  private pump(): void {
    if (this.queue.length === 0) return;
    if (!this.canProceed()) {
      // Not ready yet — if we're only token-starved, retry when a token matures.
      const wait = this.msUntilToken();
      if (wait > 0 && (this.maxConcurrent === undefined || this.inFlight < this.maxConcurrent)) {
        const t = setTimeout(() => this.pump(), wait);
        // Don't keep the process alive purely to service the queue.
        if (typeof t === 'object' && 'unref' in t) t.unref();
      }
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.take();
    next();
    // Another waiter may also be eligible.
    this.pump();
  }

  /** Wait for a slot. Returns the release function. */
  async acquire(): Promise<() => void> {
    if (this.unbounded) return () => {};
    let released = false;
    const release = (): void => {
      if (released) return; // idempotent — a double release must not free a phantom slot
      released = true;
      this.inFlight -= 1;
      this.pump();
    };

    if (this.queue.length === 0 && this.canProceed()) {
      this.take();
      return release;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
    return release;
  }
}
