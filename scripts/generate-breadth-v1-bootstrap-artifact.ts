import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateBreadthV1BootstrapArtifact } from '../src/dev/breadth-v1-bootstrap-artifact-generator.js';

const outputPath = path.join('prisma', 'bootstrap', 'breadth-v1-bootstrap-artifact.json');

const artifact = await generateBreadthV1BootstrapArtifact();
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(artifact, null, 2) + '\n');
console.log(`Wrote ${artifact.rowCount} rows (${artifact.from}..${artifact.through}) to ${outputPath}.`);
console.log(`canonicalArtifactHash: ${artifact.canonicalArtifactHash}`);
