import { spawn, type ChildProcess } from 'node:child_process';
import { getFreePort } from './free-port.js';
import { detectExternalIntegrations } from '../../classify/grep-init.js';
import type { ToolMeta, Page } from '../../types.js';

export type SpawnedServer = {
  baseUrl: string;
  port: number;
  listTools: () => Promise<ToolMeta[]>;
  listPages: (filter?: { pathPrefix?: string; lazy?: boolean }) => Promise<{ revision: number; pages: Page[] }>;
  describeSelf: () => Promise<{
    name: string;
    stack: string;
    baseUrl: string;
    toolRevision: number;
    pageRevision: number;
    capabilities: { listPages: boolean; crawlSeed?: boolean };
  }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  getEffectiveConfig: () => Promise<{
    surfaces: Array<{ _suggestedExternalIntegrations: string[] }>;
  }>;
  kill: () => Promise<void>;
  pid: number;
};

const tracked: ChildProcess[] = [];

async function mcpCall<T>(baseUrl: string, tool: string, args: unknown): Promise<T> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SurfaceMCP HTTP ${res.status}: ${await res.text()}`);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    if (dataLines.length === 0) throw new Error('Empty SSE stream from SurfaceMCP');
    const last = dataLines[dataLines.length - 1]!.slice(6);
    const parsed = JSON.parse(last) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: unknown;
    };
    if (parsed.error) throw new Error(`SurfaceMCP error: ${JSON.stringify(parsed.error)}`);
    const content = parsed.result?.content?.[0]?.text;
    if (!content) throw new Error('No content in SurfaceMCP SSE response');
    if (parsed.result?.isError) throw new Error(`SurfaceMCP tool error (${tool}): ${content}`);
    return JSON.parse(content) as T;
  }

  const json = await res.json() as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: unknown;
  };
  if (json.error) throw new Error(`SurfaceMCP error: ${JSON.stringify(json.error)}`);
  const content = json.result?.content?.[0]?.text;
  if (!content) throw new Error('No content in SurfaceMCP JSON response');
  if (json.result?.isError) throw new Error(`SurfaceMCP tool error (${tool}): ${content}`);
  return JSON.parse(content) as T;
}

async function waitReady(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not yet ready
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`SurfaceMCP server at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

export async function startSurfaceMcpServer(cwd: string): Promise<SpawnedServer> {
  const port = await getFreePort();

  const configPath = `${cwd}/surfacemcp.config.json`;

  // Patch the config port at runtime without modifying the file:
  // Pass a custom config via env; serve reads SURFACEMCP_CONFIG env var.
  // We write a temp config with the chosen free port.
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  const configRaw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    surfaces: Array<Record<string, unknown>>;
  };
  configRaw.surfaces[0] = { ...configRaw.surfaces[0], port };

  const { tmpdir } = await import('node:os');
  const tmpConfig = resolve(tmpdir(), `surfacemcp-e2e-${port}.json`);
  writeFileSync(tmpConfig, JSON.stringify(configRaw));

  const proc = spawn(
    'node',
    ['/root/SurfaceMCP/dist/cli/main.js', 'serve', '--project-root', cwd, '--config', tmpConfig],
    {
      cwd,
      env: { ...process.env, SURFACEMCP_CONFIG: tmpConfig },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  tracked.push(proc);

  proc.stderr?.on('data', () => {/* absorb */});
  proc.stdout?.on('data', () => {/* absorb */});

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitReady(baseUrl);

  const kill = (): Promise<void> => new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000);
  });

  return {
    baseUrl,
    port,
    pid: proc.pid ?? 0,
    listTools: async () => {
      const result = await mcpCall<{ revision: number; tools: ToolMeta[] }>(
        baseUrl,
        'surface_list_tools',
        {}
      );
      return result.tools;
    },
    listPages: async (filter?) => {
      return mcpCall<{ revision: number; pages: Page[] }>(baseUrl, 'surface_list_pages', { filter });
    },
    describeSelf: async () => {
      return mcpCall<{
        name: string;
        stack: string;
        baseUrl: string;
        toolRevision: number;
        pageRevision: number;
        capabilities: { listPages: boolean; crawlSeed?: boolean };
      }>(baseUrl, 'surface_describe_self', {});
    },
    callTool: (name, args) => mcpCall(baseUrl, name, args),
    getEffectiveConfig: async () => {
      const hits = detectExternalIntegrations(cwd);
      const suggested = hits.flatMap(h => h.files);
      return { surfaces: [{ _suggestedExternalIntegrations: suggested }] };
    },
    kill,
  };
}

export async function stopAll(): Promise<void> {
  await Promise.all(
    tracked.map(proc => new Promise<void>((resolve) => {
      if (proc.exitCode !== null) { resolve(); return; }
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000);
    }))
  );
  tracked.length = 0;
}
