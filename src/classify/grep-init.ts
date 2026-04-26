import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const EXTERNAL_INTEGRATIONS = [
  { pattern: /stripe/i, label: 'stripe' },
  { pattern: /sendgrid/i, label: 'sendgrid' },
  { pattern: /easypost/i, label: 'easypost' },
  { pattern: /cloudinary/i, label: 'cloudinary' },
  { pattern: /@aws-sdk/i, label: 'aws-sdk' },
  { pattern: /twilio/i, label: 'twilio' },
  { pattern: /mailgun/i, label: 'mailgun' },
  { pattern: /postmark/i, label: 'postmark' },
  { pattern: /pusher/i, label: 'pusher' },
  { pattern: /algolia/i, label: 'algolia' },
  { pattern: /plaid/i, label: 'plaid' },
];

type IntegrationHit = {
  lib: string;
  files: string[];
};

function walkDir(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (
      entry.isDirectory() &&
      !['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)
    ) {
      walkDir(full, files);
    } else if (/\.(ts|tsx|js|jsx|py)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export function detectExternalIntegrations(root: string): IntegrationHit[] {
  const allFiles = walkDir(root);
  const hits = new Map<string, string[]>();

  for (const file of allFiles) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    for (const { pattern, label } of EXTERNAL_INTEGRATIONS) {
      if (pattern.test(content)) {
        const existing = hits.get(label) ?? [];
        existing.push(file.replace(root + '/', ''));
        hits.set(label, existing);
      }
    }
  }

  return Array.from(hits.entries()).map(([lib, files]) => ({ lib, files }));
}
