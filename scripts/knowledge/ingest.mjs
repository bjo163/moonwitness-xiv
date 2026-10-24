#!/usr/bin/env node
import process from 'node:process';
import { ingestDataset } from '../../packages/corpus/dist/index.js';

const usage =
  'Usage: node scripts/knowledge/ingest.mjs <recipe.json> --output <relative-path> [--dry-run]';
const [recipePath, ...options] = process.argv.slice(2);

if (!recipePath) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
} else {
  let outputPath;
  let dryRun = false;
  let invalidOption = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--dry-run') {
      dryRun = true;
    } else if (option === '--output' && options[index + 1]) {
      outputPath = options[index + 1];
      index += 1;
    } else {
      invalidOption = true;
      break;
    }
  }
  if (invalidOption || !outputPath) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
  } else {
    try {
      const report = await ingestDataset({
        rootDirectory: process.cwd(),
        recipePath,
        outputPath,
        dryRun,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'Ingestion failed'}\n`);
      process.exitCode = 1;
    }
  }
}
