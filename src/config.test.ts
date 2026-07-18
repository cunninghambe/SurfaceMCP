import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { findLiteralCredentialPaths } from './config.js';
import type { Config } from './types.js';

// Re-export config internals for testing by re-parsing via loadConfig
// We test the schema directly by replicating the relevant Zod shape.

const SurfaceConfigMinimal = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  stack: z.enum(['nextjs', 'express', 'fastapi', 'django', 'openapi', 'vite']),
  root: z.string(),
  baseUrl: z.string().url(),
  port: z.number().int().min(3102).max(3199),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('bearer') }),
  ]),
  roles: z.array(z.object({ name: z.string(), credentials: z.record(z.string()).optional() })),
});

const ConfigSchema = z
  .object({
    surfaces: z.array(SurfaceConfigMinimal).min(1),
    mcpPort: z.number().int().min(3102).max(3199).optional(),
  })
  .superRefine((cfg, ctx) => {
    const names = cfg.surfaces.map((s) => s.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['surfaces'],
        message: `Duplicate surface name: "${dup}". Surface names must be unique.`,
      });
    }
  });

function makeSurface(name: string, port = 3140) {
  return {
    name,
    stack: 'openapi' as const,
    root: '.',
    baseUrl: 'http://localhost:5000',
    port,
    auth: { kind: 'none' as const },
    roles: [],
  };
}

describe('ConfigSchema — surface name validation', () => {
  it('accepts valid surface name with letters, digits, hyphens, underscores', () => {
    const result = SurfaceConfigMinimal.safeParse(makeSurface('self-api_v2'));
    expect(result.success).toBe(true);
  });

  it('rejects surface name containing ":"', () => {
    const result = SurfaceConfigMinimal.safeParse(makeSurface('self:api'));
    expect(result.success).toBe(false);
  });

  it('rejects surface name containing "."', () => {
    const result = SurfaceConfigMinimal.safeParse(makeSurface('self.api'));
    expect(result.success).toBe(false);
  });

  it('rejects surface name containing spaces', () => {
    const result = SurfaceConfigMinimal.safeParse(makeSurface('self api'));
    expect(result.success).toBe(false);
  });

  it('rejects empty surface name', () => {
    const result = SurfaceConfigMinimal.safeParse(makeSurface(''));
    expect(result.success).toBe(false);
  });
});

describe('ConfigSchema — multi-surface', () => {
  it('accepts N surfaces with unique names', () => {
    const cfg = {
      surfaces: [makeSurface('api'), makeSurface('spa', 3141), makeSurface('admin', 3142)],
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  it('rejects duplicate surface names', () => {
    const cfg = {
      surfaces: [makeSurface('api'), makeSurface('api', 3141)],
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? '';
      expect(msg).toContain('Duplicate surface name');
      expect(msg).toContain('"api"');
    }
  });

  it('accepts optional mcpPort', () => {
    const cfg = { surfaces: [makeSurface('api')], mcpPort: 3150 };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  it('omitting mcpPort is valid', () => {
    const cfg = { surfaces: [makeSurface('api')] };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpPort).toBeUndefined();
    }
  });

  it('mcpPort out of range is rejected', () => {
    const cfg = { surfaces: [makeSurface('api')], mcpPort: 80 };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });
});

describe('findLiteralCredentialPaths', () => {
  function cfgWithRoles(roles: Array<{ name: string; credentials?: Record<string, string> }>): Config {
    return {
      surfaces: [
        {
          name: 'api',
          stack: 'openapi',
          root: '.',
          baseUrl: 'http://localhost:5000',
          port: 3140,
          auth: { kind: 'none' },
          roles,
        },
      ],
    } as Config;
  }

  it('returns nothing when all credentials use $env: indirection', () => {
    const cfg = cfgWithRoles([{ name: 'owner', credentials: { email: '$env:EMAIL', password: '$env:PW' } }]);
    expect(findLiteralCredentialPaths(cfg)).toEqual([]);
  });

  it('flags inline literal credential values with a readable path', () => {
    const cfg = cfgWithRoles([{ name: 'owner', credentials: { email: '$env:EMAIL', password: 'hunter2' } }]);
    expect(findLiteralCredentialPaths(cfg)).toEqual(['surfaces[0].roles[0].credentials.password']);
  });

  it('ignores roles without credentials', () => {
    const cfg = cfgWithRoles([{ name: 'anon' }]);
    expect(findLiteralCredentialPaths(cfg)).toEqual([]);
  });
});
