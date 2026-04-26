import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function hasFastApiInFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const text = readFileSync(filePath, 'utf-8').toLowerCase();
    return text.includes('fastapi');
  } catch {
    return false;
  }
}

export function isFastApi(root: string): boolean {
  return (
    hasFastApiInFile(resolve(root, 'pyproject.toml')) ||
    hasFastApiInFile(resolve(root, 'requirements.txt')) ||
    hasFastApiInFile(resolve(root, 'requirements-dev.txt'))
  );
}
