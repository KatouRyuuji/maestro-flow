import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '#maestro-dashboard/agents': resolve(__dirname, 'src/server/agents'),
      '#maestro-dashboard/shared': resolve(__dirname, 'src/shared'),
      '#maestro-dashboard/wiki': resolve(__dirname, 'src/server/wiki'),
      '#async': resolve(__dirname, '../src/async'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', '../src/**/*.test.ts'],
    exclude: ['src/server/execution/execution-scheduler.test.ts'],
    environment: 'node',
  },
});
