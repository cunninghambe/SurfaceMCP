import type { Stack } from '../types.js';
import { isNextjs } from './nextjs.js';
import { isDjango } from './django.js';
import { isExpress } from './express.js';
import { isFastApi } from './fastapi.js';
import { isOpenApi } from './openapi.js';

/**
 * Detect the stack for a given directory. First match wins per spec § 3.3.
 * Returns null if detection fails ('unknown').
 */
export function detectStack(root: string): Stack | null {
  if (isNextjs(root)) return 'nextjs';
  if (isDjango(root)) return 'django';
  if (isExpress(root)) return 'express';
  if (isFastApi(root)) return 'fastapi';
  if (isOpenApi(root)) return 'openapi';
  return null;
}
