// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000, // render pipeline tests invoke OpenSCAD and need more time
  retries: 0,
  workers: 1, // Electron tests must run sequentially
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
  },
});
