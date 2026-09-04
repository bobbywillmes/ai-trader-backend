import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/lifecycle-repair-acceptance/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
