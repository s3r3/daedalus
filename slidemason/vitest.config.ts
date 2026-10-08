import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/dist/**', '**/node_modules/**'],
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./packages/primitives/src/__tests__/setup.ts'],
  },
});
