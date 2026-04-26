import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function isOpenApi(root: string): boolean {
  const candidates = [
    'openapi.json',
    'openapi.yaml',
    'openapi.yml',
    'swagger.json',
    'swagger.yaml',
    'swagger.yml',
  ];
  return candidates.some((f) => existsSync(resolve(root, f)));
}
