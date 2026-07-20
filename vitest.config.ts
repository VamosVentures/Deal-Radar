import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    environment: 'node',
    env: {
      DATABASE_FILE: ':memory:',
      DATA_FILE: ':memory:',
      NODE_ENV: 'test',
      ADMIN_PASSWORD: 'test-admin-password',
    },
  },
});
