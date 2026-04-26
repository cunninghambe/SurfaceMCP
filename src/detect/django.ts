import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function isDjango(root: string): boolean {
  return (
    existsSync(resolve(root, 'manage.py')) &&
    (existsSync(resolve(root, 'settings.py')) ||
      existsSync(resolve(root, 'config/settings.py')) ||
      existsSync(resolve(root, 'core/settings.py')))
  );
}
