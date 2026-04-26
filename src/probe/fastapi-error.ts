import type { JsonSchema2020 } from '../types.js';

type FastApiErrorItem = {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
  input?: unknown;
};

/**
 * Recover a JSON Schema from FastAPI validation error response.
 * Shape: { detail: [{ loc: ['body', 'field'], msg: '...', type: '...' }] }
 * FastAPI uses same Pydantic shape but detail is always an array.
 */
export function recoverFromFastApiError(body: unknown): JsonSchema2020 | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  const detail = b['detail'];
  if (!Array.isArray(detail)) return null;

  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];

  for (const item of detail as FastApiErrorItem[]) {
    if (!item.loc || !Array.isArray(item.loc)) continue;
    const lastLoc = item.loc[item.loc.length - 1];
    const fieldName = typeof lastLoc === 'string' ? lastLoc : String(lastLoc);
    if (fieldName === 'body') continue;

    const prop: JsonSchema2020 = {};
    const errType = item.type ?? '';

    if (errType.includes('string')) prop.type = 'string';
    else if (errType.includes('int')) prop.type = 'integer';
    else if (errType.includes('float')) prop.type = 'number';
    else if (errType.includes('bool')) prop.type = 'boolean';
    else prop.type = 'string';

    const msg = item.msg ?? '';
    if (/email/i.test(msg)) prop.format = 'email';
    if (/url/i.test(msg)) prop.format = 'uri';

    properties[fieldName] = prop;
    if (!required.includes(fieldName)) required.push(fieldName);
  }

  if (Object.keys(properties).length === 0) return null;

  return { type: 'object', properties, required };
}
