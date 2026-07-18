import type { Stack } from '../types.js';
import { isNextjs } from './nextjs.js';
import { isVite } from './vite.js';
import { isDjango } from './django.js';
import { isExpress } from './express.js';
import { isFastify } from './fastify.js';
import { isFastApi } from './fastapi.js';
import { isOpenApi } from './openapi.js';

/**
 * Detect the stack for a given directory. First match wins per spec § 3.3.
 * Returns null if detection fails ('unknown').
 */
export function detectStack(root: string): Stack | null {
  if (isNextjs(root)) return 'nextjs';
  if (isVite(root)) return 'vite';       // before express — a Vite app may have express as dev dep
  if (isDjango(root)) return 'django';
  if (isExpress(root)) return 'express';
  if (isFastify(root)) return 'fastify'; // after express — both use .get/.post, keyed on the fastify dep
  if (isFastApi(root)) return 'fastapi';
  if (isOpenApi(root)) return 'openapi';
  return null;
}
