import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: 'experience.spec.js',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:18125',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: root + 'test-results/experience-regressions',
  reporter: [['list'], ['json', { outputFile: root + 'test-results/experience-regression-results.json' }]],
  webServer: {
    cwd: root,
    command: 'npm run build && node docs/qa/2026-09-09/start-server.mjs',
    url: 'http://127.0.0.1:18125/healthz',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
