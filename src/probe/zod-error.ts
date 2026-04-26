import type { JsonSchema2020 } from '../types.js';

type ZodFlatError = {
  formErrors?: string[];
  fieldErrors?: Record<string, string[]>;
};

/**
 * Attempt to recover a JSON Schema from a zod flattenedError response shape.
 */
export function recoverFromZodError(body: unknown): JsonSchema2020 | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // zod's flatten() shape: { formErrors: [], fieldErrors: { field: ['message'] } }
  const flatError = (b['error'] ?? b) as ZodFlatError;
  if (!flatError || typeof flatError !== 'object') return null;

  const fieldErrors = flatError.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object') return null;

  const properties: Record<string, JsonSchema2020> = {};
  const required: string[] = [];

  for (const [field, messages] of Object.entries(fieldErrors)) {
    const prop: JsonSchema2020 = { type: 'string' };

    // Infer format/constraints from error messages
    const msgs = Array.isArray(messages) ? messages : [String(messages)];
    for (const msg of msgs) {
      if (/email/i.test(msg)) prop.format = 'email';
      else if (/url/i.test(msg)) prop.format = 'uri';
      else if (/uuid/i.test(msg)) prop.format = 'uuid';

      const minMatch = /at least (\d+)/.exec(msg) ?? /minimum length.*?(\d+)/.exec(msg);
      if (minMatch) prop.minLength = parseInt(minMatch[1], 10);

      const maxMatch = /at most (\d+)/.exec(msg) ?? /maximum length.*?(\d+)/.exec(msg);
      if (maxMatch) prop.maxLength = parseInt(maxMatch[1], 10);
    }

    properties[field] = prop;
    required.push(field);
  }

  if (Object.keys(properties).length === 0) return null;

  return { type: 'object', properties, required };
}
