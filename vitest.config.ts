import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    environment: 'node',
    env: {
      DATA_FILE: ':memory:',
      INTEGRATION_MODE: 'mock',
      NODE_ENV: 'test',
    },
  },
});
