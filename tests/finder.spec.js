// @ts-check
// Find & Print (v0.8) in the DESKTOP app.
//
// Everything here runs offline. CLAWSCAD_FINDER_FIXTURES points the main process
// at tests/fixtures/finder/: both sites are answered from recorded responses and
// the Bambu Studio CLI and bambu_ctl.py are replaced by a fake that starts NO
// process (main/finder/fixture-runner.js). The fake appends one JSON line per
// call to CLAWSCAD_FINDER_RUNNER_LOG, which is how the print tests prove what
// would have been run: for example that `print` was called exactly once, and
// never before the bed was confirmed clear. The real printer is never reached.
//
// LAUNCH MODEL: one Electron app for the serial group, a second one for the
// "printer is busy" case (the printer state is an environment variable of the
// fake). The workspace is unique to this run, so nothing leaks into another spec.
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_PATH = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'finder');
const STAMP = Date.now();
const WORKSPACE = path.join(os.tmpdir(), 'clawscad-finder-test-' + STAMP);
const WORKSPACE_BUSY = path.join(os.tmpdir(), 'clawscad-finder-busy-' + STAMP);
const RUNNER_LOG = path.join(os.tmpdir(), `clawscad-finder-runner-${STAMP}.jsonl`);
const RUNNER_LOG_BUSY = path.join(os.tmpdir(), `clawscad-finder-runner-busy-${STAMP}.jsonl`);

function runnerCalls(file) {
  try {
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const printCalls = (file) => runnerCalls(file).filter((c) => c.args[1] === 'print');

async function launch(workspace, log, printerState) {
  fs.mkdirSync(workspace, { recursive: true });
  const app = await electron.launch({
    args: [path.join(APP_PATH, 'main.js'), workspace],
    cwd: APP_PATH,
    env: {
      ...process.env,
      CLAWSCAD_FINDER_FIXTURES: FIXTURES,
      CLAWSCAD_FINDER_MIN_INTERVAL_MS: '0',
      CLAWSCAD_FINDER_RUNNER_LOG: log,
      CLAWSCAD_FINDER_PRINTER_STATE: printerState,
    },
  });
  try {
    const p = await app.firstWindow();
    await p.waitForLoadState('domcontentloaded');
    await p.waitForFunction(() => !!window.clawscadStudio && !!window.clawscadFinder, null, { timeout: 30000 });
    return { app, p };
  } catch (err) {
    await app.close().catch(() => {});
    throw err;
  }
}

/** Opens the tab and lands on the search view (the tab remembers the last model page). */
async function openFinder(p) {
  await p.locator('#view-finder').click();
  await expect(p.locator('#finder')).toBeVisible();
  const back = p.locator('#finder-back');
  if (await back.isVisible()) await back.click();
}

async function search(p, text) {
  await p.locator('#finder-query').fill(text);
  await p.locator('#finder-go').click();
  await expect(p.locator('.finder-card:not(.is-skeleton)').first()).toBeVisible({ timeout: 15000 });
}

test.beforeAll(() => {
  const { execSync } = require('child_process');
  execSync('npm run build:renderer', { cwd: APP_PATH, stdio: 'pipe' });
});

test.afterAll(() => {
  for (const f of [WORKSPACE, WORKSPACE_BUSY]) fs.rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  for (const f of [RUNNER_LOG, RUNNER_LOG_BUSY]) fs.rmSync(f, { force: true });
});

test.describe.serial('Find & Print, desktop', () => {
  /** @type {import('@playwright/test').ElectronApplication} */
  let app;
  /** @type {import('@playwright/test').Page} */
  let page;

  test.beforeAll(async () => {
    ({ app, p: page } = await launch(WORKSPACE, RUNNER_LOG, 'IDLE'));
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  test('the Find & Print tab switches views and the others switch back', async () => {
    const tab = page.locator('#view-finder');
    await expect(tab).toBeVisible();
    await expect(tab).toHaveText('Find & Print');
    await expect(page.locator('#view-switch [role="tab"]')).toHaveCount(3);

    await openFinder(page);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#view-studio')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#studio')).toBeHidden();
    await expect(page.locator('#main-content')).toBeHidden();
    await expect(page.locator('#finder-intro')).toBeVisible();

    await page.locator('#view-studio').click();
    await expect(page.locator('#studio')).toBeVisible();
    await expect(page.locator('#finder')).toBeHidden();
    await expect(tab).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#view-studio')).toHaveAttribute('aria-selected', 'true');

    await openFinder(page);
    await page.locator('#view-workbench').click();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('#finder')).toBeHidden();
    await expect(tab).toHaveAttribute('aria-selected', 'false');
  });

  test('one search shows both sites, interleaved, with site badges and chips filter', async () => {
    await openFinder(page);
    await search(page, 'gridfinity');
    const cards = page.locator('.finder-card:not(.is-skeleton)');
    await expect(cards).toHaveCount(6);
    const sites = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-site')));
    expect(sites).toEqual(['makerworld', 'printables', 'makerworld', 'printables', 'makerworld', 'printables']);
    await expect(cards.first().locator('.finder-badge')).toHaveText('MakerWorld');
    await expect(cards.nth(1).locator('.finder-card-author')).toHaveText('by Pred');
    await expect(cards.nth(1).locator('.finder-licence')).toHaveText('CC BY-NC');
    await expect(page.locator('#finder-status')).toContainText('6 shown for "gridfinity"');

    // Thingiverse is a stub: visible, disabled, and says why.
    const thingi = page.locator('.finder-chip[data-site="thingiverse"]');
    await expect(thingi).toBeDisabled();
    await expect(thingi).toContainText('needs token');

    await page.locator('.finder-chip[data-site="makerworld"]').click(); // turn MakerWorld off
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-site')))).toEqual(['printables', 'printables', 'printables']);
    // the last site cannot be switched off
    await page.locator('.finder-chip[data-site="printables"]').click();
    await expect(page.locator('.finder-chip[data-site="printables"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.finder-chip[data-site="all"]').click();
    await expect(cards).toHaveCount(6);
  });

  test('Show more asks for the next page and goes away when both sites are out of results', async () => {
    await openFinder(page);
    await search(page, 'gridfinity');
    const more = page.locator('#finder-more-btn');
    await expect(more).toBeVisible();
    await more.click();
    await expect(more).toBeHidden();
    // nothing was lost, and nothing was added twice
    await expect(page.locator('.finder-card:not(.is-skeleton)')).toHaveCount(6);
    expect(await page.evaluate(() => window.clawscadFinder.state().results.page)).toBe(1);
  });

  test('one site failing does not hide the other site', async () => {
    await openFinder(page);
    await search(page, 'fail-pr gridfinity');
    const cards = page.locator('.finder-card:not(.is-skeleton)');
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-site')))).toEqual(['makerworld', 'makerworld', 'makerworld']);
    const note = page.locator('.finder-note.is-error');
    await expect(note).toContainText('Printables did not answer');
    await expect(note).toContainText('403');
    await expect(note.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('a search with no hits says what was searched', async () => {
    await openFinder(page);
    await search(page, 'gridfinity'); // reset to a good state first
    await page.locator('#finder-query').fill('zzempty');
    await page.locator('#finder-go').click();
    await expect(page.locator('#finder-empty')).toContainText('Nothing found for "zzempty"');
  });

  test('a Printables model page shows licence, files and the actions', async () => {
    await openFinder(page);
    await search(page, 'gridfinity');
    await page.locator('.finder-card[data-id="printables:543553"]').click();
    await expect(page.locator('#finder-title')).toContainText('Gridfinity Storage Box by Pred');
    await expect(page.locator('#finder-licence .finder-licence')).toHaveText('CC BY-NC');
    await expect(page.locator('#finder-licence')).toContainText('Not for selling or commercial use');
    await expect(page.locator('#finder-files .finder-file').first()).toBeVisible();
    // printable files first; the STEP/F3D files are listed but locked with a reason
    await expect(page.locator('.finder-file.is-locked').first()).toContainText('STL and 3MF only');
    await expect(page.locator('#finder-print-btn')).toBeEnabled();
    await expect(page.locator('#finder-open-btn')).toBeEnabled();
    const link = page.locator('#finder-actions a', { hasText: 'Open on Printables' });
    await expect(link).toHaveAttribute('href', /printables\.com\/model\/543553/);
    await expect(link).toHaveAttribute('rel', /noopener/);
    // Escape goes back to the results
    await page.keyboard.press('Escape');
    await expect(page.locator('#finder-detail')).toBeHidden();
    await expect(page.locator('.finder-card').first()).toBeVisible();
  });

  test('a MakerWorld model page says it needs a Bambu login and offers the source link', async () => {
    await openFinder(page);
    await search(page, 'gridfinity');
    await page.locator('.finder-card[data-id="makerworld:1685835"]').click();
    await expect(page.locator('#finder-title')).toContainText('Lightest Gridfinity Base Ever');
    await expect(page.locator('#finder-print-btn')).toBeDisabled();
    await expect(page.locator('#finder-open-btn')).toBeDisabled();
    await expect(page.locator('#finder-print-why')).toContainText('Needs Bambu login');
    await expect(page.locator('#finder-licence .finder-licence')).toHaveText('Standard Digital File License');
    await expect(page.locator('#finder-actions a', { hasText: 'Open on MakerWorld' })).toHaveAttribute('href', /makerworld\.com\/en\/models\/1685835/);
    await expect(page.locator('#finder-plates')).toBeVisible();
    await expect(page.locator('.finder-file.is-locked').first()).toContainText('Needs Bambu login');
    await page.locator('#finder-back').click();
  });

  test('Open in ClawSCAD downloads one file and writes a new mesh checkpoint', async () => {
    await openFinder(page);
    await search(page, 'gridfinity');
    await page.locator('.finder-card[data-id="printables:543553"]').click();
    await expect(page.locator('#finder-files')).toBeVisible();
    await page.locator('.finder-file[data-file-id="9990001"] button').click();
    await expect(page.locator('.finder-file[data-file-id="9990001"] button')).toHaveAttribute('aria-checked', 'true');
    await page.locator('#finder-open-btn').click();
    await expect(page.locator('#finder-open-done')).toBeVisible({ timeout: 20000 });

    const modelDir = path.join(WORKSPACE, 'models', 'printables-543553');
    expect(fs.existsSync(path.join(modelDir, 'cube-20mm.stl'))).toBe(true);
    expect(fs.statSync(path.join(modelDir, 'cube-20mm.stl')).size).toBe(684);
    const source = JSON.parse(fs.readFileSync(path.join(modelDir, 'source.json'), 'utf-8'));
    expect(source.site).toBe('printables');
    expect(source.author).toBe('Pred');
    expect(source.licence).toBe('CC BY-NC');
    expect(source.url).toMatch(/printables\.com\/model\/543553/);
    expect(Number.isNaN(Date.parse(source.fetched))).toBe(false);

    const scads = fs.readdirSync(WORKSPACE).filter((f) => f.endsWith('.scad') && f !== 'active.scad' && /gridfinity/.test(f));
    expect(scads.length).toBe(1);
    expect(scads[0].length).toBeLessThanOrEqual(30);
    expect(scads[0]).toMatch(/^[a-z0-9-]+\.scad$/);
    const text = fs.readFileSync(path.join(WORKSPACE, scads[0]), 'utf-8');
    const first = text.split('\n')[0];
    expect(first.startsWith('//')).toBe(true);
    expect(first).toContain('Printables #543553');
    expect(first).toContain('CC BY-NC');
    expect(text).toContain('color(');
    expect(text).toMatch(/translate\(\[-10, -10, 0\]\)/);
    const meshRel = /import\("([^"]+)"/.exec(text)[1];
    expect(meshRel.startsWith('meshes/')).toBe(true);
    expect(meshRel.includes('\\')).toBe(false);
    expect(fs.existsSync(path.join(WORKSPACE, meshRel))).toBe(true);

    // The checkpoint is registered in the running app, and the button gets us there.
    await page.locator('#finder-show-workbench').click();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('#checkpoint-tree')).toContainText(path.basename(scads[0], '.scad').replace(/-/g, ' ').slice(0, 20), { timeout: 15000 });
  });

  test('printing needs a slice, a bed picture and a ticked box, and sends exactly one print', async () => {
    fs.rmSync(RUNNER_LOG, { force: true });
    await openFinder(page);
    await search(page, 'gridfinity');
    await page.locator('.finder-card[data-id="printables:543553"]').click();
    await page.locator('.finder-file[data-file-id="9990001"] button').click();
    await expect(page.locator('#finder-print-btn')).toBeEnabled();
    await page.locator('#finder-print-btn').click();

    // 1. the printer and its AMS slots (the recorded idle status)
    await expect(page.locator('#finder-printer-state')).toHaveText('IDLE');
    await expect(page.locator('.finder-tray')).toHaveCount(4);
    await expect(page.locator('.finder-tray[data-slot="3"]')).toContainText('empty');
    await expect(page.locator('.finder-tray[data-slot="3"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.finder-tray[data-slot="1"]')).toHaveAttribute('aria-checked', 'true');
    await page.locator('.finder-tray[data-slot="4"]').click();
    await expect(page.locator('.finder-tray[data-slot="4"]')).toHaveAttribute('aria-checked', 'true');

    // The start button refuses, and says why, until every step is done.
    await expect(page.locator('#finder-start-btn')).toBeDisabled();
    await expect(page.locator('#finder-start-why')).toHaveText('Slice the model first.');

    // 2. slice
    await page.locator('#finder-slice-btn').click();
    await expect(page.locator('#finder-slice-done')).toContainText('13m 40s', { timeout: 20000 });
    await expect(page.locator('#finder-start-btn')).toBeDisabled();
    await expect(page.locator('#finder-start-why')).toHaveText('Look at the bed first.');

    // 3. the bed picture, then the tick
    await page.locator('#finder-snap-btn').click();
    await expect(page.locator('#finder-snapshot')).toBeVisible();
    await expect(page.locator('#finder-start-why')).toContainText('The bed is clear');
    await expect(page.locator('#finder-start-btn')).toBeDisabled();
    expect(printCalls(RUNNER_LOG)).toHaveLength(0);
    await page.locator('#finder-clear').check();
    await expect(page.locator('#finder-start-btn')).toBeEnabled();
    expect(printCalls(RUNNER_LOG)).toHaveLength(0); // still nothing sent

    // 4. start
    await page.locator('#finder-start-btn').click();
    await expect(page.locator('#finder-running')).toContainText('Print started', { timeout: 20000 });

    const prints = printCalls(RUNNER_LOG);
    expect(prints).toHaveLength(1);
    expect(prints[0].args).toContain('--ams-mapping');
    expect(prints[0].args[prints[0].args.indexOf('--ams-mapping') + 1]).toBe('3'); // slot 4 = tray 3
    expect(prints[0].args[2]).toMatch(/renders[\\/]finder[\\/].+\.gcode\.3mf$/);

    // The slicer calls the fake saw: a project build and a slice, both with --arrange 0,
    // and the part staged under renders/finder (never anywhere else).
    const slicer = runnerCalls(RUNNER_LOG).filter((c) => c.file.startsWith('bambu-studio'));
    expect(slicer).toHaveLength(2);
    for (const c of slicer) expect(c.args.join(' ')).toContain('--arrange 0');
    expect(slicer[1].args).toContain('--slice');

    // The ONLY programs the fake was asked to run are the two known tools.
    for (const c of runnerCalls(RUNNER_LOG)) expect(['python', 'bambu-studio.fixture']).toContain(c.file);
  });
});

test.describe('Find & Print, busy printer', () => {
  test('a printer that is RUNNING blocks the start button and nothing is sent', async () => {
    const { app, p } = await launch(WORKSPACE_BUSY, RUNNER_LOG_BUSY, 'RUNNING');
    try {
      await openFinder(p);
      await search(p, 'gridfinity');
      await p.locator('.finder-card[data-id="printables:543553"]').click();
      await p.locator('.finder-file[data-file-id="9990001"] button').click();
      await p.locator('#finder-print-btn').click();
      await expect(p.locator('#finder-printer-state')).toHaveText('RUNNING');
      await expect(p.locator('#finder-printer-line')).toContainText('IDLE or FINISH');
      await p.locator('#finder-slice-btn').click(); // slicing is allowed while busy
      await expect(p.locator('#finder-slice-done')).toBeVisible({ timeout: 20000 });
      await p.locator('#finder-snap-btn').click();
      await expect(p.locator('#finder-snapshot')).toBeVisible();
      await p.locator('#finder-clear').check();
      await expect(p.locator('#finder-start-btn')).toBeDisabled();
      await expect(p.locator('#finder-start-why')).toContainText('RUNNING');
      expect(printCalls(RUNNER_LOG_BUSY)).toHaveLength(0);
    } finally {
      await app.close().catch(() => {});
    }
  });
});
