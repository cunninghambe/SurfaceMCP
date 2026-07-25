// Per-surface call coverage + learned response schemas.
//
// SurfaceMCP knows the whole surface but, until now, kept no record of which of
// it had actually been exercised. Downstream agents (BugHunter) claim exhaustive
// coverage with no way to measure it. This tracks, per tool: how often it was
// called, which statuses came back, and — from successful responses — an inferred
// `outputSchema` for stacks that can't be statically introspected.
//
// In-memory only and reset on restart: this is a live signal for the current
// session, not durable analytics.

import type { JsonSchema2020, SurfaceCallResult, ToolMeta } from '../types.js';
import { inferJsonSchema, mergeSchemas } from './infer-schema.js';

export type ToolCoverage = {
  toolId: string;
  name: string;
  method: string;
  path: string;
  calls: number;
  /** Count of responses per HTTP status code seen. */
  statuses: Record<string, number>;
  errors: number;
  lastDurationMs?: number;
  /** Schema inferred from observed 2xx bodies, widened across observations. */
  learnedOutputSchema?: JsonSchema2020;
  /** How many successful bodies contributed to `learnedOutputSchema`. */
  observations: number;
};

export type CoverageSnapshot = {
  summary: {
    toolsTotal: number;
    toolsCalled: number;
    toolsUncalled: number;
    /** Tools whose input schema is still `unknown` — the discovery gap. */
    inputSchemaUnknown: number;
    /** Tools with neither a static nor a learned output schema. */
    outputSchemaMissing: number;
    totalCalls: number;
  };
  /** Per-tool detail, sorted by toolId for stable output. */
  tools: ToolCoverage[];
  /** Names of tools never called — the actionable worklist. */
  uncalled: string[];
};

export class CoverageTracker {
  private readonly byToolId = new Map<string, ToolCoverage>();

  /** Record the outcome of a call. Never throws — telemetry must not break a call. */
  record(tool: ToolMeta, result: SurfaceCallResult): void {
    try {
      // Coverage must mean "actually exercised". A dry run sends nothing, and a
      // pre-flight refusal (read-only, external guard, revision pin, missing path
      // param, bad cookie) never reaches the target — none of those count. A
      // `fetch_error` DOES count: the request was attempted.
      if (result.dryRun) return;
      const reachedTarget = result.status !== undefined || result.error?.code === 'fetch_error';
      if (!reachedTarget) return;

      let entry = this.byToolId.get(tool.toolId);
      if (!entry) {
        entry = {
          toolId: tool.toolId,
          name: tool.name,
          method: tool.method,
          path: tool.path,
          calls: 0,
          statuses: {},
          errors: 0,
          observations: 0,
        };
        this.byToolId.set(tool.toolId, entry);
      }

      entry.calls += 1;
      entry.lastDurationMs = result.durationMs;
      if (result.status !== undefined) {
        const key = String(result.status);
        entry.statuses[key] = (entry.statuses[key] ?? 0) + 1;
      }
      if (result.error) entry.errors += 1;

      // Learn the response shape from successful, untruncated bodies only — a
      // truncated body would teach a wrong (partial) schema.
      const learnable =
        result.ok &&
        !result.bodyTruncated &&
        result.body !== undefined &&
        result.body !== null &&
        typeof result.body === 'object';
      if (learnable) {
        const observed = inferJsonSchema(result.body);
        entry.learnedOutputSchema = entry.learnedOutputSchema
          ? mergeSchemas(entry.learnedOutputSchema, observed)
          : observed;
        entry.observations += 1;
      }
    } catch {
      // Coverage is best-effort; swallow so a bad body can't fail the call.
    }
  }

  /** Learned schema for a tool, if any successful body has been observed. */
  learnedSchemaFor(toolId: string): JsonSchema2020 | undefined {
    return this.byToolId.get(toolId)?.learnedOutputSchema;
  }

  /** Coverage report for a catalog of tools (includes never-called tools). */
  snapshot(catalogTools: ToolMeta[]): CoverageSnapshot {
    const tools: ToolCoverage[] = [];
    const uncalled: string[] = [];
    let totalCalls = 0;
    let inputSchemaUnknown = 0;
    let outputSchemaMissing = 0;

    for (const t of catalogTools) {
      const rec = this.byToolId.get(t.toolId);
      if (t.inputSchemaConfidence === 'unknown') inputSchemaUnknown += 1;
      if (!t.outputSchema && !rec?.learnedOutputSchema) outputSchemaMissing += 1;

      if (rec) {
        totalCalls += rec.calls;
        tools.push(rec);
      } else {
        uncalled.push(t.name);
        tools.push({
          toolId: t.toolId,
          name: t.name,
          method: t.method,
          path: t.path,
          calls: 0,
          statuses: {},
          errors: 0,
          observations: 0,
        });
      }
    }

    tools.sort((a, b) => a.toolId.localeCompare(b.toolId));
    uncalled.sort();

    return {
      summary: {
        toolsTotal: catalogTools.length,
        toolsCalled: catalogTools.length - uncalled.length,
        toolsUncalled: uncalled.length,
        inputSchemaUnknown,
        outputSchemaMissing,
        totalCalls,
      },
      tools,
      uncalled,
    };
  }
}
