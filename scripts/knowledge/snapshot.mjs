#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import { validateKnowledgeDataset } from './validate.mjs';

export async function main(args) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('Usage: node scripts/knowledge/snapshot.mjs <dataset-directory>\n');
    return 2;
  }
  try {
    const { createKnowledgeSnapshot } = await import(
      new URL('../../packages/knowledge/dist/src/index.js', import.meta.url).href
    );
    const report = await validateKnowledgeDataset(args[0], { includeData: true });
    if (!report.valid || !report.dataset) {
      process.stderr.write(`${JSON.stringify({ valid: false, issues: report.issues }, null, 2)}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(createKnowledgeSnapshot(report.dataset), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
