import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
      include: ['**/*.test.ts'], // Only include test files
      globals: true, // Enbale vitest's globals API
      environment: 'node', // Use node.js environment
      // Every suite shares one local MongoDB/Redis instance and the test app
      // owns one process-wide connection. Parallel files race during startup
      // and make their beforeAll hooks time out.
      fileParallelism: false,
      maxConcurrency: 1,
      hookTimeout: 30000,
      testTimeout: 30000,
      typecheck: {
        tsconfig: 'tsconfig.json', // Ensure that vitest uses the correct tsconfig file
      },
    },
  });
