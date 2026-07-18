import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RawToolMeta, JsonSchema2020 } from '../../types.js';
import { toolId, pathToToolName, methodToSideEffect } from '../common.js';

type OpenApiSpec = {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, OpenApiOp>>;
};

type OpenApiContent = Record<string, { schema?: JsonSchema2020 }>;

type OpenApiOp = {
  operationId?: string;
  summary?: string;
  requestBody?: {
    content?: OpenApiContent;
  };
  parameters?: Array<{
    in: string;
    name: string;
    schema?: JsonSchema2020;
    required?: boolean;
  }>;
  responses?: Record<string, { content?: OpenApiContent }>;
};

function normalizeApiPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

/**
 * Extract the JSON response schema for a route's success (2xx) response, so tools
 * advertise what they return. Prefers 200 → 201 → any 2xx → `default`. May contain
 * `$ref`s into components (left unresolved, as with request schemas).
 */
export function extractResponseSchema(op: {
  responses?: Record<string, { content?: OpenApiContent }>;
}): JsonSchema2020 | undefined {
  const responses = op.responses ?? {};
  const preferred = ['200', '201', '202', '203', '204', '2XX', 'default'];
  const code =
    preferred.find((c) => responses[c]) ??
    Object.keys(responses).find((c) => /^2\d\d$/.test(c));
  if (!code) return undefined;
  const content = responses[code]?.content;
  return content?.['application/json']?.schema ?? undefined;
}

function parseSpec(content: string, filePath: string): OpenApiSpec {
  if (filePath.endsWith('.json')) {
    return JSON.parse(content) as OpenApiSpec;
  }
  // Basic YAML to JSON — for production, use a real yaml parser
  // This handles common cases in fixture files
  throw new Error('YAML OpenAPI specs require a YAML parser. Use JSON format or add yaml package.');
}

export function extractOpenApiRoutes(root: string): RawToolMeta[] {
  const candidates = [
    'openapi.json',
    'openapi.yaml',
    'openapi.yml',
    'swagger.json',
    'swagger.yaml',
    'swagger.yml',
  ];

  let spec: OpenApiSpec | null = null;
  let specFile = '';

  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf-8');
      spec = parseSpec(content, path);
      specFile = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!spec) return [];

  const tools: RawToolMeta[] = [];
  const nameCounts = new Map<string, number>();

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    const normalizedPath = normalizeApiPath(path);

    for (const [method, op] of Object.entries(methods)) {
      const validMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
      if (!validMethods.includes(method.toLowerCase())) continue;

      let schema: JsonSchema2020 = { type: 'object', additionalProperties: true };
      let confidence: RawToolMeta['inputSchemaConfidence'] = 'unknown';

      if (op.requestBody?.content) {
        const jsonContent =
          op.requestBody.content['application/json'] ??
          op.requestBody.content['application/x-www-form-urlencoded'];
        if (jsonContent?.schema) {
          schema = jsonContent.schema;
          confidence = 'introspected';
        }
      } else {
        const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query');
        if (queryParams.length > 0) {
          const properties: Record<string, JsonSchema2020> = {};
          const required: string[] = [];
          for (const param of queryParams) {
            properties[param.name] = param.schema ?? { type: 'string' };
            if (param.required) required.push(param.name);
          }
          schema = { type: 'object', properties, required: required.length ? required : undefined };
          confidence = 'introspected';
        }
      }

      const base = pathToToolName(method, path);
      const count = nameCounts.get(base) ?? 0;
      nameCounts.set(base, count + 1);
      const name = count === 0 ? base : `${base}_${count + 1}`;

      const outputSchema = extractResponseSchema(op);

      tools.push({
        name,
        toolId: toolId(method.toUpperCase(), normalizedPath),
        method: method.toUpperCase(),
        path: normalizedPath,
        inputSchema: schema,
        inputSchemaConfidence: confidence,
        ...(outputSchema ? { outputSchema } : {}),
        sideEffectClass: methodToSideEffect(method),
        sourceFile: specFile,
        sourceLine: 0,
        isServerAction: false,
      });
    }
  }

  return tools;
}
