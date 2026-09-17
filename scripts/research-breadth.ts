import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { estimateBreadthResearch, runBreadthResearch, type BreadthResearchReport } from '../src/dev/breadth-research-runner.js';
import { renderBreadthMarkdownReport } from '../src/dev/breadth-research-report.js';
import { etDate } from '../src/services/market-calendar.js';
import { prisma } from '../src/db/prisma.js';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
function hasFlag(name: string): boolean { return process.argv.includes(`--${name}`); }

const from = readFlag('from') ?? '2021-09-16';
const to = readFlag('to') ?? etDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
const outputPath = readFlag('output');
const fetchFromProvider = hasFlag('fetch');
const refresh = hasFlag('refresh');
const usage = 'Usage: research:breadth -- --from YYYY-MM-DD --to YYYY-MM-DD [--fetch] [--refresh] [--output file.json]';

try {
  if (readFlag('from') !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(usage);
  if (readFlag('to') !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error(usage);

  const estimate = await estimateBreadthResearch({ from, to });
  console.log('Request estimate (before any provider fetch):');
  console.log(JSON.stringify(estimate, null, 2));

  if (!fetchFromProvider) {
    console.log('\n--fetch was not given: reporting from cache only. New provider requests will not be made.');
  } else {
    console.log(`\n--fetch given: performing up to ${estimate.estimatedTotalRequests} new provider request(s)${refresh ? ' (--refresh: ignoring existing cache)' : ''}.`);
  }

  const report: BreadthResearchReport = await runBreadthResearch({ from, to, fetchFromProvider, refresh });
  const { days: _days, ...withoutDays } = report;
  console.log('\nSummary:');
  console.log(JSON.stringify(withoutDays, null, 2));

  const markdown = renderBreadthMarkdownReport(report);
  if (outputPath) {
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
    const markdownPath = outputPath.replace(/\.json$/i, '') + '.md';
    await writeFile(markdownPath, markdown);
    console.log(`\nWrote full evidence to ${outputPath} and the behavior report to ${markdownPath}.`);
  } else {
    console.log('\n' + markdown);
  }
} finally {
  await prisma.$disconnect();
}
