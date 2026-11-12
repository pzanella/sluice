import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: {
    command: 'node test-env/env.mjs run',
    url: 'http://localhost:8080/config.json',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
