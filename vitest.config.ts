import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // The first Microsoft-SSO test in a run pays for generating the
    // fixture RSA keypair and populating the JWKS cache; the default
    // 5000ms is tight on a slower CI/build machine even though every
    // later test in that file reuses the cache and runs in ~100-200ms.
    testTimeout: 15000,
    env: {
      DATABASE_FILE: ':memory:',
      DATA_FILE: ':memory:',
      NODE_ENV: 'test',
      ADMIN_PASSWORD: 'test-admin-password',
    },
  },
});
