import { configJsonSchema } from '../config.js';

/**
 * Print the JSON Schema for surfacemcp.config.json to stdout. Pipe it to a file
 * and reference it from the config for editor autocomplete + validation:
 *   surfacemcp schema > surfacemcp.config.schema.json
 *   // then add "$schema": "./surfacemcp.config.schema.json" to the config
 */
export function runSchema(): void {
  process.stdout.write(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
}
