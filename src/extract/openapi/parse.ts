import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolMeta, JsonSchema2020, SideEffectClass } from '../../types.js';

type OpenApiSpec = {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, OpenApiOp>>;
};

type OpenApiOp = {
  operationId?: string;
  summary?: string;
  requestBody?: {
    content?: Record<string, { schema?: JsonSchema2020 }>;
  };
  parameters?: Array<{
    in: string;
    name: string;
    schema?: JsonSchema2020;
    required?: boolean;
  }>;
};

function toolId(method: string, path: string): string {
  return createHash('sha1').update(`${method}:${path}`).digest('hex').slice(0, 12);
}

function pathToToolName(method: string, path: string): string {
  const normalized = path
    .replace(/^\//, '')
    .replace(/[/{:]/g, '_')
    .replace(/}/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${normalized || 'root'}`;
}

function methodToSideEffect(method: string): SideEffectClass {
  if (['get', 'head', 'options'].includes(method.toLowerCase())) return 'safe';
  return 'mutating';
}

function normalizeApiPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

function parseSpec(content: string, filePath: string): OpenApiSpec {
  if (filePath.endsWith('.json')) {
    return JSON.parse(content) as OpenApiSpec;
  }
  // Basic YAML to JSON — for production, use a real yaml parser
  // This handles common cases in fixture files
  throw new Error('YAML OpenAPI specs require a YAML parser. Use JSON format or add yaml package.');
}

export function extractOpenApiRoutes(root: string): ToolMeta[] {
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

  const tools: ToolMeta[] = [];
  const nameCounts = new Map<string, number>();

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    const normalizedPath = normalizeApiPath(path);

    for (const [method, op] of Object.entries(methods)) {
      const validMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
      if (!validMethods.includes(method.toLowerCase())) continue;

      let schema: JsonSchema2020 = { type: 'object', additionalProperties: true };
      let confidence: ToolMeta['inputSchemaConfidence'] = 'unknown';

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

      tools.push({
        name,
        toolId: toolId(method.toUpperCase(), normalizedPath),
        method: method.toUpperCase(),
        path: normalizedPath,
        inputSchema: schema,
        inputSchemaConfidence: confidence,
        sideEffectClass: methodToSideEffect(method),
        sourceFile: specFile,
        sourceLine: 0,
        isServerAction: false,
      });
    }
  }

  return tools;
}
