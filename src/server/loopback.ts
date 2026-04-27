import type { Request } from 'express';

/** Returns true when the request arrived from a loopback address (127.x.x.x, ::1, ::ffff:127.x.x.x). */
export function isLoopbackRemote(req: Request): boolean {
  const addr = req.socket?.remoteAddress ?? '';
  if (addr === '::1' || addr === '127.0.0.1') return true;
  // IPv4-mapped IPv6 loopback
  if (addr.startsWith('::ffff:127.')) return true;
  // Plain IPv4 127.x.x.x
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return true;
  return false;
}
