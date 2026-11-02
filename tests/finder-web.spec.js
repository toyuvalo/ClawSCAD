// @ts-check
// Find & Print (v0.8) in the WEB build, driven in a real Chromium page.
//
// What it starts: web/server.js on a free loopback port, a temp workspace, the
// recorded site fixtures (no network), and a bundle built into a temp folder with
// `node web/build.js --outdir`, served through CLAWSCAD_WEB_DIST. So this spec
// never replaces web/dist/app.js, the file a live server is serving. Everything it
// starts is stopped and deleted in afterAll.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const APP_PATH = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'finder');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

test.describe.serial('Find & Print, web build', () => {
  let child;
  let base = '';
  let workspace = '';
  let dist = '';

  test.beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-finder-web-'));
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-finder-web-dist-'));
    execFileSync(process.execPath, [path.join(APP_PATH, 'web', 'build.js'), '--outdir', dist], { cwd: APP_PATH, stdio: 'pipe' });
    const port = await freePort();
    child = spawn(
      process.execPath,
      [path.join(APP_PATH, 'web', 'server.js'), '--workspace', workspace, '--state', path.join(workspace, '.state'), '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: APP_PATH,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAWSCAD_WEB_DIST: dist, CLAWSCAD_FINDER_FIXTURES: FIXTURES, CLAWSCAD_FINDER_MIN_INTERVAL_MS: '0' },
      }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (out += c.toString()));
    const deadline = Date.now() + 20000;
    while (!out.includes(`http://127.0.0.1:${port}`)) {
      if (Date.now() > deadline) throw new Error('web server did not start: ' + out);
      await new Promise((r) => setTimeout(r, 100));
    }
    base = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    if (child) {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
          resolve(undefined);
        }, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve(undefined);
        });
        try {
          child.kill();
        } catch {
          clearTimeout(t);
          resolve(undefined);
        }
      });
    }
    // Windows can hold a just-killed server's folder for a moment (EBUSY). A temp
    // folder that survives is harmless; a failed teardown is not.
    for (const d of [workspace, dist]) {
      if (!d) continue;
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        /* left behind in %TEMP% */
      }
    }
  });

  test('the tab appears, a search shows Printables cards and a model page opens', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/');
    const tab = page.locator('#view-finder');
    await expect(tab).toBeVisible({ timeout: 15000 });
    await tab.click();
    await expect(page.locator('#finder')).toBeVisible();
    await expect(page.locator('#studio')).toBeHidden();
    await expect(tab).toHaveAttribute('aria-selected', 'true');

    await page.locator('#finder-query').fill('gridfinity');
    await page.keyboard.press('Enter');
    const cards = page.locator('.finder-card:not(.is-skeleton)');
    await expect(cards).toHaveCount(6, { timeout: 15000 });
    await expect(page.locator('.finder-card[data-site="makerworld"]')).toHaveCount(3);
    await expect(page.locator('.finder-card[data-site="printables"]')).toHaveCount(3);
    await expect(page.locator('.finder-chip[data-site="cults3d"]')).toBeDisabled();
    expect((await page.locator('#finder').innerText()).toLowerCase()).toContain('makerworld');

    await page.locator('.finder-card[data-id="printables:543553"]').click();
    await expect(page.locator('#finder-title')).toContainText('Gridfinity Storage Box by Pred');
    // The web build cannot print: the button is disabled and the reason is written beside it.
    await expect(page.locator('#finder-print-btn')).toBeDisabled();
    await expect(page.locator('#finder-print-why')).toContainText('desktop app');
    await expect(page.locator('#finder-open-btn')).toBeEnabled();
    // In a browser a plain link does the job (no finderOpenExternal bridge).
    await expect(page.locator('#finder-actions a', { hasText: 'Open on Printables' })).toHaveAttribute('target', '_blank');

    await page.locator('#finder-back').click();
    await page.locator('#view-studio').click();
    await expect(page.locator('#studio')).toBeVisible();
    await expect(page.locator('#finder')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Open in ClawSCAD works in the browser build, and the raw download is never served back', async ({ page }) => {
    await page.goto(base + '/');
    await page.locator('#view-finder').click();
    await page.locator('#finder-query').fill('gridfinity');
    await page.keyboard.press('Enter');
    await page.locator('.finder-card[data-id="printables:543553"]').click();
    await page.locator('.finder-file[data-file-id="9990001"] button').click();
    await page.locator('#finder-open-btn').click();
    await expect(page.locator('#finder-open-done')).toBeVisible({ timeout: 20000 });

    const stl = path.join(workspace, 'models', 'printables-543553', 'cube-20mm.stl');
    expect(fs.existsSync(stl)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'models', 'printables-543553', 'source.json'))).toBe(true);
    const scads = fs.readdirSync(workspace).filter((f) => f.endsWith('.scad') && /gridfinity/.test(f));
    expect(scads.length).toBeGreaterThan(0);

    for (const url of ['/api/model/file?path=models/printables-543553/cube-20mm.stl', '/api/model/download?path=models/printables-543553/cube-20mm.stl']) {
      const res = await page.request.get(base + url);
      expect(res.status(), url).toBe(403);
    }
    // the copy under meshes/ is a normal workspace mesh and is served as before
    const meshRel = /import\("([^"]+)"/.exec(fs.readFileSync(path.join(workspace, scads[0]), 'utf-8'))[1];
    const ok = await page.request.get(base + '/api/model/file?path=' + encodeURIComponent(meshRel));
    expect(ok.status()).toBe(200);
  });

  test('the printer routes refuse in the browser build', async ({ page }) => {
    await page.goto(base + '/');
    for (const route of ['/api/finder/printer-status', '/api/finder/print-prepare', '/api/finder/print-start']) {
      const res = await page.request.post(base + route, { data: {}, headers: { 'content-type': 'application/json' } });
      expect(res.status(), route).toBe(403);
      expect((await res.json()).error.code).toBe('desktop-only');
    }
  });
});
