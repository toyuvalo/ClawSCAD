// @ts-check
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-claw-gen.exe');
const TEST_WORKSPACE = path.join(os.tmpdir(), 'clawscad-gen-test-' + Date.now());

let electronApp;
let page;

function findCsc() {
  const frameworkRoot = 'C:\\Windows\\Microsoft.NET\\Framework64';
  if (!fs.existsSync(frameworkRoot)) return null;
  const versions = fs.readdirSync(frameworkRoot).filter((v) => v.startsWith('v')).sort().reverse();
  for (const v of versions) {
    const candidate = path.join(frameworkRoot, v, 'csc.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test.beforeAll(async () => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // Compile the fake CLI fixture to a real .exe. A genuine native binary is
  // required (not a .js/.cmd) because Node's child_process refuses to spawn
  // .bat/.cmd without `shell: true`, which the app never uses.
  const csc = findCsc();
  if (!csc) {
    throw new Error('csc.exe (.NET Framework) not found — cannot build the fake claw-gen fixture');
  }
  const cs = path.join(__dirname, 'fixtures', 'fake-claw-gen.cs');
  execSync(`"${csc}" /nologo /out:"${FAKE_CLI}" "${cs}"`, { stdio: 'pipe' });
});

test.afterEach(async () => {
  if (electronApp) {
    await electronApp.close();
    electronApp = null;
  }
});

test.afterAll(async () => {
  // Leave the shared userData profile clean for other spec files.
  const cleanupApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  const cleanupPage = await cleanupApp.firstWindow();
  await cleanupPage.evaluate(() => window.api.setPipelineCliPath(null));
  await cleanupApp.close();

  fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
});

async function launchApp() {
  electronApp = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), TEST_WORKSPACE],
    cwd: APP_PATH,
  });
  electronApp.process().stdout.on('data', (d) => console.log('MAIN:', d.toString()));
  electronApp.process().stderr.on('data', (d) => console.log('MAINERR:', d.toString()));
  page = await electronApp.firstWindow();
  page.on('console', (msg) => console.log('PAGE:', msg.text()));
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  return page;
}

// ── Empty State ──────────────────────────────────────────────────────

test.describe('Generate Panel — empty state', () => {
  // Electron's userData dir persists across test runs (it's keyed by app
  // name, not per-launch), so explicitly clear any CLI path a prior run may
  // have left behind rather than assuming a pristine profile.
  async function resetToUnconfigured() {
    await launchApp();
    await page.evaluate(() => window.api.setPipelineCliPath(null));
    await page.reload();
    await page.waitForTimeout(1000);
    await page.locator('#gen-toggle').click();
  }

  test('shows the unconfigured message with no CLI set', async () => {
    await resetToUnconfigured();

    const empty = page.locator('#gen-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No generation pipeline configured');
    await expect(page.locator('#gen-readme-link')).toBeVisible();

    const configured = page.locator('#gen-configured');
    await expect(configured).toHaveClass(/hidden/);
  });

  test('never throws or blocks app startup with no CLI configured', async () => {
    await resetToUnconfigured();
    // The rest of the app should still be fully functional.
    await expect(page.locator('#viewport')).toBeVisible();
    await expect(page.locator('#checkpoint-panel')).toBeVisible();
  });
});

// ── Configured State ─────────────────────────────────────────────────

test.describe('Generate Panel — configured state', () => {
  test('backends list renders once a CLI is configured', async () => {
    await launchApp();
    await page.evaluate((cliPath) => window.api.setPipelineCliPath(cliPath), FAKE_CLI);
    await page.reload();
    await page.waitForTimeout(1000);
    await page.locator('#gen-toggle').click();

    await expect(page.locator('#gen-configured')).not.toHaveClass(/hidden/);
    await expect(page.locator('#gen-empty')).toHaveClass(/hidden/);

    const backendCheck = page.locator('.gen-backend-check');
    await expect(backendCheck).toContainText('fake-backend');
  });

  test('generating images populates the candidate grid', async () => {
    await launchApp();
    await page.evaluate((cliPath) => window.api.setPipelineCliPath(cliPath), FAKE_CLI);
    await page.reload();
    await page.waitForTimeout(1000);
    await page.locator('#gen-toggle').click();

    await page.locator('#gen-prompt').fill('a chunky test widget');
    await page.locator('#gen-generate-btn').click();

    // Cancel button should appear while the job runs.
    await expect(page.locator('#gen-cancel-btn')).not.toHaveClass(/hidden/);

    // Fake CLI writes 4 candidates (default count) after ~1.2s.
    await expect(page.locator('.gen-candidate')).toHaveCount(4, { timeout: 15000 });
    const firstImg = page.locator('.gen-candidate img').first();
    await expect(firstImg).toBeVisible();
    const src = await firstImg.getAttribute('src');
    expect(src).toMatch(/^data:image\/png;base64,/);

    // Job finished — Cancel hides again.
    await expect(page.locator('#gen-cancel-btn')).toHaveClass(/hidden/, { timeout: 5000 });
  });

  test('selecting a candidate and running Make 3D drives mesh -> prep -> checkpoint and the checkpoint tree updates', async () => {
    await launchApp();
    await page.evaluate((cliPath) => window.api.setPipelineCliPath(cliPath), FAKE_CLI);
    await page.reload();
    await page.waitForTimeout(1000);
    await page.locator('#gen-toggle').click();

    await page.locator('#gen-prompt').fill('a chunky test widget');
    await page.locator('#gen-generate-btn').click();
    await expect(page.locator('.gen-candidate')).toHaveCount(4, { timeout: 15000 });

    const makeBtn = page.locator('#gen-make3d-btn');
    await expect(makeBtn).toBeDisabled();

    await page.locator('.gen-candidate').first().click();
    await expect(page.locator('.gen-candidate.selected')).toHaveCount(1);
    await expect(makeBtn).toBeEnabled();

    await makeBtn.click();
    await expect(page.locator('#gen-cancel-btn')).not.toHaveClass(/hidden/);

    await page.waitForTimeout(5000);
    console.log('LOG PANEL:', await page.locator('#gen-log').innerText());
    console.log('scad exists?', fs.existsSync(path.join(TEST_WORKSPACE, 'fake-gen-checkpoint.scad')));
    console.log('workspace listing:', fs.readdirSync(TEST_WORKSPACE));
    console.log('checkpoints via IPC:', await page.evaluate(() => window.api.getCheckpoints()));

    fs.writeFileSync(path.join(TEST_WORKSPACE, 'manual-probe.scad'), '// manual probe\ncube(1);\n');
    await page.waitForTimeout(2000);
    console.log('checkpoints after manual probe write:', await page.evaluate(() => window.api.getCheckpoints()));

    // The fake CLI's checkpoint stage writes a real .scad file into the
    // workspace; the app's existing file watcher should pick it up.
    await expect(page.locator('#checkpoint-tree')).toContainText('fake gen checkpoint', { timeout: 15000 });

    const scadPath = path.join(TEST_WORKSPACE, 'fake-gen-checkpoint.scad');
    expect(fs.existsSync(scadPath)).toBe(true);
  });

  test('Cancel stops a running job', async () => {
    await launchApp();
    await page.evaluate((cliPath) => window.api.setPipelineCliPath(cliPath), FAKE_CLI);
    await page.reload();
    await page.waitForTimeout(1000);
    await page.locator('#gen-toggle').click();

    await page.locator('#gen-prompt').fill('a widget to cancel');
    await page.locator('#gen-generate-btn').click();
    await expect(page.locator('#gen-cancel-btn')).not.toHaveClass(/hidden/);

    // Cancel well before the fake CLI's 1.2s delay produces any candidates.
    await page.waitForTimeout(300);
    await page.locator('#gen-cancel-btn').click();

    await expect(page.locator('#gen-cancel-btn')).toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#gen-generate-btn')).toBeEnabled();
    // No candidates should have made it through — the job was killed first.
    await expect(page.locator('.gen-candidate')).toHaveCount(0);
  });
});
