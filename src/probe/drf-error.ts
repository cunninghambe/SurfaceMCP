import type { JsonSchema2020 } from '../types.js';

/**
 * Recover a JSON Schema from Django REST Framework validation error response.
 * Shape: { field: ['error message'], another_field: ['error'] }
 */
export function recoverFromDrfError(body: unknown): JsonSchema2020 | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;

  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];

  for (const [field, errors] of Object.entries(b)) {
    if (field === 'non_field_errors' || field === 'detail') continue;
    if (!Array.isArray(errors)) continue;

    const prop: JsonSchema2020 = { type: 'string' };
    for (const msg of errors as string[]) {
      if (typeof msg !== 'string') continue;
      if (/email/i.test(msg)) prop.format = 'email';
      if (/url/i.test(msg)) prop.format = 'uri';
    }

    properties[field] = prop;
    required.push(field);
  }

  if (Object.keys(properties).length === 0) return null;

  return { type: 'object', properties, required };
}
