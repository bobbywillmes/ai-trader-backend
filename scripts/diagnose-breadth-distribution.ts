import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { diagnoseBreadthDistribution } from '../src/dev/breadth-distribution-diagnostic.js';
import { renderBreadthDistributionDiagnosticReport } from '../src/dev/breadth-distribution-diagnostic-report.js';
import { MissingCacheError } from '../src/dev/breadth-threshold-comparison.js';
import { prisma } from '../src/db/prisma.js';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const from = readFlag('from') ?? '2021-09-16';
const to = readFlag('to') ?? '2026-09-16';
const outputPath = readFlag('output');

try {
  let diagnostic;
  try {
    diagnostic = await diagnoseBreadthDistribution({ from, to });
  } catch (error) {
    if (error instanceof MissingCacheError) {
      console.error(error.message);
      console.error('Missing grouped dates:', JSON.stringify(error.missingGroupedDates));
      console.error('Missing universe dates:', JSON.stringify(error.missingUniverseDates));
      process.exitCode = 1;
      throw error;
    }
    throw error;
  }
  const markdown = renderBreadthDistributionDiagnosticReport(diagnostic);
  if (outputPath) {
    await writeFile(outputPath, JSON.stringify(diagnostic, null, 2) + '\n');
    const markdownPath = outputPath.replace(/\.json$/i, '') + '.md';
    await writeFile(markdownPath, markdown);
    console.log(`Wrote full diagnostic to ${outputPath} and the report to ${markdownPath}.`);
  } else {
    console.log(markdown);
  }
} finally {
  await prisma.$disconnect();
}
