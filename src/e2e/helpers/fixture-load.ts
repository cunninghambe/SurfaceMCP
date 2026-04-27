import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const PerRouteAssertionSchema = z.object({
  inputSchemaConfidence: z.enum(['introspected', 'inferred', 'partial', 'unknown']),
  requiredFields: z.array(z.string()).optional(),
});

const ServerActionAssertionSchema = z.object({
  name: z.string(),
  kind: z.enum(['file-level', 'function-level', 'form-bound']),
  definitionFile: z.string(),
  toolId: z.string(),
  inputSchemaConfidence: z.enum(['introspected', 'inferred', 'partial', 'unknown']),
  requiredFields: z.array(z.string()).optional(),
});

const MustDiscoverSchema = z.object({
  routes: z.array(z.string()),
  serverActions: z.array(ServerActionAssertionSchema),
  perRoute: z.record(PerRouteAssertionSchema).optional(),
  suggestedExternalIntegrations: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }).optional(),
});

export type MustDiscover = z.infer<typeof MustDiscoverSchema>;

export function loadFixtureMustDiscover(fixtureRoot: string): MustDiscover {
  const filePath = resolve(fixtureRoot, 'MUST_DISCOVER.json');
  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  return MustDiscoverSchema.parse(raw);
}
