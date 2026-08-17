import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/manual-acceptance/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
