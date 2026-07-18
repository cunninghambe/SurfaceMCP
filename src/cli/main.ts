#!/usr/bin/env node
import 'dotenv/config';

const [, , command, ...rest] = process.argv;

function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        const key = arg.slice(2, eq);
        result[key] = arg.slice(eq + 1);
      } else {
        result[arg.slice(2)] = true;
      }
    } else {
      result['_pos'] = arg; // positional
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(rest);

  switch (command) {
    case 'init': {
      const { runInit } = await import('./init.js');
      await runInit({
        stack: typeof args['stack'] === 'string' ? args['stack'] : undefined,
        baseUrl: typeof args['base-url'] === 'string' ? args['base-url'] : undefined,
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
        multiSurface: args['multi-surface'] === true,
        noInteractive: args['no-interactive'] === true,
      });
      break;
    }

    case 'serve': {
      const { runServe } = await import('./serve.js');
      await runServe({
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
        configPath: typeof args['config'] === 'string' ? args['config'] : undefined,
      });
      break;
    }

    case 'tools': {
      const { runTools } = await import('./tools.js');
      await runTools({
        filter: typeof args['filter'] === 'string' ? args['filter'] : undefined,
        confidence: typeof args['confidence'] === 'string' ? args['confidence'] : undefined,
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
      });
      break;
    }

    case 'call': {
      const toolName = typeof args['_pos'] === 'string' ? args['_pos'] : rest[0];
      if (!toolName) {
        console.error('Usage: surfacemcp call <tool> --role=<role> --input=\'<json>\'');
        process.exit(1);
      }
      const { runCall } = await import('./call.js');
      await runCall({
        tool: toolName,
        role: typeof args['role'] === 'string' ? args['role'] : 'default',
        input: typeof args['input'] === 'string' ? args['input'] : '{}',
        allowExternal: args['allow-external'] === true,
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
      });
      break;
    }

    case 'probe': {
      const toolName = typeof args['_pos'] === 'string' ? args['_pos'] : rest[0];
      if (!toolName) {
        console.error('Usage: surfacemcp probe <tool> --role=<role>');
        process.exit(1);
      }
      const { runProbe } = await import('./probe.js');
      await runProbe({
        tool: toolName,
        role: typeof args['role'] === 'string' ? args['role'] : 'default',
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
      });
      break;
    }

    case 'regenerate': {
      const { runRegenerate } = await import('./regenerate.js');
      await runRegenerate({
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
      });
      break;
    }

    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      await runDoctor({
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
      });
      break;
    }

    case 'schema': {
      const { runSchema } = await import('./schema.js');
      runSchema();
      break;
    }

    case 'export': {
      const { runExport } = await import('./export.js');
      await runExport({
        projectRoot: typeof args['project-root'] === 'string' ? args['project-root'] : undefined,
        surface: typeof args['surface'] === 'string' ? args['surface'] : undefined,
        out: typeof args['out'] === 'string' ? args['out'] : undefined,
      });
      break;
    }

    default:
      console.log(`
surfacemcp — HTTP MCP server for typed API surface discovery

Commands:
  init          Detect stack, allocate port, write surfacemcp.config.json
  serve         Start the MCP server
  tools         List discovered tools
  call <tool>   Invoke a tool from CLI
  probe <tool>  Recover schema from validation error response
  regenerate    Force re-extraction
  doctor        Validate config, test logins, check ports
  schema        Print the JSON Schema for surfacemcp.config.json
  export        Emit an OpenAPI 3.1 doc for the surface (--surface, --out)

Options:
  --stack=<nextjs|express|fastify|nestjs|fastapi|django|vite|openapi|graphql>
  --base-url=<url>
  --project-root=<path>
  --multi-surface
  --no-interactive
  --role=<role>
  --input='<json>'
  --allow-external
  --filter=<pattern>
  --confidence=<level>
`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
