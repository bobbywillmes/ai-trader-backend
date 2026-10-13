import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['scripts/ui-acceptance/**/*.test.ts'], environment: 'node' } });
