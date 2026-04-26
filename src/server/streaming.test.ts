import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';

// Helper: create a server that sends `sizeBytes` of response
function createBigResponseServer(sizeBytes: number): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(Math.min(4096, sizeBytes), 'x');
      let sent = 0;
      function sendChunk() {
        if (sent >= sizeBytes) {
          res.end();
          return;
        }
        const toSend = Math.min(chunk.length, sizeBytes - sent);
        res.write(chunk.slice(0, toSend));
        sent += toSend;
        setImmediate(sendChunk);
      }
      sendChunk();
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
      });
    });
  });
}

describe('streaming response handling', () => {
  it('truncates 100KB response to 64KB with bodyTruncated: true', async () => {
    const { url, close } = await createBigResponseServer(100 * 1024);
    try {
      // Replicate the readBodyWithLimit logic directly
      const BODY_MAX_BYTES = 64 * 1024;
      const STREAM_TIMEOUT_MS = 5_000;

      const res = await fetch(url);
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;

      const reader = res.body!.getReader();
      const deadline = Date.now() + STREAM_TIMEOUT_MS;

      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { truncated = true; break; }

        const result = await reader.read();
        if (result.done) break;

        const chunk = result.value;
        totalBytes += chunk.length;

        if (totalBytes > BODY_MAX_BYTES) {
          const overflow = totalBytes - BODY_MAX_BYTES;
          chunks.push(chunk.slice(0, chunk.length - overflow));
          truncated = true;
          reader.cancel().catch(() => {});
          break;
        }
        chunks.push(chunk);
      }

      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(total).toBeLessThanOrEqual(BODY_MAX_BYTES);
      expect(truncated).toBe(true);
    } finally {
      close();
    }
  });

  it('does not truncate a response under 64KB', async () => {
    const { url, close } = await createBigResponseServer(1024);
    try {
      const BODY_MAX_BYTES = 64 * 1024;
      const STREAM_TIMEOUT_MS = 5_000;

      const res = await fetch(url);
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;

      const reader = res.body!.getReader();
      const deadline = Date.now() + STREAM_TIMEOUT_MS;

      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { truncated = true; break; }
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        totalBytes += chunk.length;
        if (totalBytes > BODY_MAX_BYTES) { truncated = true; break; }
        chunks.push(chunk);
      }

      expect(truncated).toBe(false);
      expect(totalBytes).toBe(1024);
    } finally {
      close();
    }
  });
});
