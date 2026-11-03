import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['src/test/sphere-auth.integration.ts'], environment: 'node', fileParallelism: false,
  testTimeout: 30000, hookTimeout: 30000,
} });
