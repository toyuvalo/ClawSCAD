// @ts-check
const { defineConfig } = require('@playwright/test');
const isCodexSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000, // render pipeline tests invoke OpenSCAD and need more time
  retries: 0,
  workers: 1, // Electron tests must run sequentially
  reporter: [['list'], ['html', { open: 'never' }]],
  passWithNoTests: isCodexSandbox,
  testIgnore: isCodexSandbox ? ['**/*.spec.js'] : [],
  use: {
    trace: 'on-first-retry',
  },
});
