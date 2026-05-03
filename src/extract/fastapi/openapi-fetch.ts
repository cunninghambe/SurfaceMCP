import { createHash } from 'node:crypto';
import type { RawToolMeta, JsonSchema2020, SideEffectClass } from '../../types.js';
import { extractOpenApiRoutes } from '../openapi/parse.js';
import { log } from '../../log.js';

type OpenApiSchema = {
  openapi?: string;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, JsonSchema2020>;
  };
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: {
    content?: Record<string, { schema?: JsonSchema2020 }>;
    required?: boolean;
  };
  parameters?: Array<{
    in: string;
    name: string;
    schema?: JsonSchema2020;
    required?: boolean;
  }>;
  responses?: Record<string, unknown>;
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

function buildInputSchema(
  op: OpenApiOperation,
  method: string
): { schema: JsonSchema2020; confidence: RawToolMeta['inputSchemaConfidence'] } {
  // For POST/PUT/PATCH, use requestBody
  if (['post', 'put', 'patch'].includes(method.toLowerCase()) && op.requestBody?.content) {
    const jsonContent =
      op.requestBody.content['application/json'] ??
      op.requestBody.content['application/x-www-form-urlencoded'];
    if (jsonContent?.schema) {
      return { schema: jsonContent.schema, confidence: 'introspected' };
    }
  }

  // For GET, build schema from query parameters
  const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query');
  if (queryParams.length > 0) {
    const properties: Record<string, JsonSchema2020> = {};
    const required: string[] = [];
    for (const param of queryParams) {
      properties[param.name] = param.schema ?? { type: 'string' };
      if (param.required) required.push(param.name);
    }
    return {
      schema: { type: 'object', properties, required: required.length ? required : undefined },
      confidence: 'introspected',
    };
  }

  return { schema: { type: 'object', additionalProperties: true }, confidence: 'unknown' };
}

function specToTools(spec: OpenApiSchema): RawToolMeta[] {
  const tools: RawToolMeta[] = [];
  const nameCounts = new Map<string, number>();

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    const normalizedPath = normalizeApiPath(path);

    for (const [method, op] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method.toLowerCase())) {
        const { schema, confidence } = buildInputSchema(op, method);
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
          sourceFile: '',
          sourceLine: 0,
          isServerAction: false,
        });
      }
    }
  }

  return tools;
}

export async function fetchFastApiSchema(baseUrl: string, root?: string): Promise<RawToolMeta[]> {
  const openApiUrl = `${baseUrl.replace(/\/$/, '')}/openapi.json`;

  let spec: OpenApiSchema | null = null;
  try {
    const res = await fetch(openApiUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spec = await res.json() as OpenApiSchema;
  } catch (err) {
    log.warn({ openApiUrl, err: String(err) }, 'FastAPI live fetch failed; trying static fallback');
  }

  if (!spec) {
    if (root) {
      const fallback = extractOpenApiRoutes(root);
      if (fallback.length > 0) {
        log.info({ count: fallback.length }, 'FastAPI catalog from static openapi.json');
        return fallback;
      }
    }
    log.warn({ openApiUrl }, 'FastAPI catalog empty: no live server, no static spec');
    return [];
  }

  return specToTools(spec);
}
