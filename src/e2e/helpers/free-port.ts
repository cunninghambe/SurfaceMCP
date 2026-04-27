import * as net from 'node:net';

/** Returns a free port in the SurfaceMCP-allowed range 3102–3199. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryPort(port: number): void {
      if (port > 3199) {
        reject(new Error('No free port found in range 3102–3199'));
        return;
      }
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.listen(port, '127.0.0.1', () => {
        srv.close((err) => {
          if (err) reject(err);
          else resolve(port);
        });
      });
    }
    tryPort(3102);
  });
}
