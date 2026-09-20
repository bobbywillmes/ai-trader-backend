import 'dotenv/config';
import { participationMain } from '../src/dev/participation-research-runner.js';

await participationMain(process.argv.slice(2));
