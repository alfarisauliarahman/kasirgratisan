import { defineConfig } from 'vitest/config';

// Config sendiri supaya test di sini tidak mewarisi setup jsdom dari root repo.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    root: import.meta.dirname,
  },
});
