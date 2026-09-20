import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeParticipation } from './participation-analysis.js';

export async function analyzeParticipationFile(input: string, output: string) {
  if (path.resolve(input) === path.resolve(output)) throw new Error('Analysis output must not overwrite its source report.');
  const source = await readFile(input, 'utf8');
  const analysis = analyzeParticipation(JSON.parse(source));
  const sourceArtifactSha256 = createHash('sha256').update(source).digest('hex');
  const content = { ...analysis, sourceArtifactSha256 };
  const report = { ...content, analysisDigest: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}
export async function participationAnalysisMain(args: string[]) {
  if (args.length === 1 && args[0] === '--help') { console.log('analyze:participation [--input PATH] [--output PATH] (existing report only; no provider or DB access)'); return; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--input', '--output'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(`Unknown/duplicate option or missing value: ${key}`);
    options.set(key, value);
  }
  const output = options.get('--output') ?? 'node_modules/.cache/participation-v1/calibration-report.json';
  const report = await analyzeParticipationFile(options.get('--input') ?? 'node_modules/.cache/participation-v1/reference-report.json', output);
  console.log(JSON.stringify({ output, sourceDatasetId: report.sourceDatasetId, analysisDigest: report.analysisDigest,
    validObservations: report.validObservations, stateDistribution: report.stateDistribution, transitions: report.transitions,
    runs: report.runs, oneDayRuns: report.oneDayRuns, control40: report.control40, evidenceCoverage: report.evidenceCoverage }, null, 2));
}
