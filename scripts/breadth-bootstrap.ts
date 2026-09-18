import 'dotenv/config';
import { applyBreadthV1Bootstrap, previewBreadthV1Bootstrap } from '../src/services/breadth-v1-bootstrap-import.service.js';
import { prisma } from '../src/db/prisma.js';

const apply = process.argv.includes('--apply');

try {
  if (!apply) {
    const preview = await previewBreadthV1Bootstrap();
    console.log(JSON.stringify(preview, null, 2));
    if (preview.conflicts.length) {
      console.error(`${preview.conflicts.length} conflicting existing session(s) found. Resolve before running with --apply.`);
      process.exitCode = 1;
    } else {
      console.log(`Preview only: ${preview.inserts} would be inserted, ${preview.existingMatches} already match, 0 conflicts. Re-run with --apply to write.`);
    }
  } else {
    const result = await applyBreadthV1Bootstrap();
    console.log(JSON.stringify(result, null, 2));
    console.log(`Applied: inserted ${result.inserted}, skipped ${result.skipped} (already present).`);
  }
} finally {
  await prisma.$disconnect();
}
