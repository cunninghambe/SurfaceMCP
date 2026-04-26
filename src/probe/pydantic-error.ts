import type { JsonSchema2020 } from '../types.js';

type PydanticErrorItem = {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
};

/**
 * Recover a JSON Schema from Pydantic v2 validation error response.
 * Shape: { detail: [{ loc: ['body', 'field'], msg: '...', type: '...' }] }
 */
export function recoverFromPydanticError(body: unknown): JsonSchema2020 | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  const detail = b['detail'];
  if (!Array.isArray(detail)) return null;

  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];

  for (const item of detail as PydanticErrorItem[]) {
    if (!item.loc || !Array.isArray(item.loc)) continue;
    // loc is like ['body', 'fieldName'] or ['fieldName']
    const fieldName = item.loc.find((l) => typeof l === 'string' && l !== 'body') as string | undefined;
    if (!fieldName) continue;

    const prop: JsonSchema2020 = { type: 'string' };
    const msg = item.msg ?? '';

    if (/email/i.test(msg)) prop.format = 'email';
    if (/url/i.test(msg)) prop.format = 'uri';
    if (/int|integer/i.test(msg)) prop.type = 'integer';
    if (/float|number/i.test(msg)) prop.type = 'number';

    properties[fieldName] = prop;
    if (!required.includes(fieldName)) required.push(fieldName);
  }

  if (Object.keys(properties).length === 0) return null;

  return { type: 'object', properties, required };
}
