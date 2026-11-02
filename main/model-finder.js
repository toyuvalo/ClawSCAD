// main/model-finder.js — "Find & Print" (v0.8), the Electron side.
//
// All behaviour lives in main/finder/ (plain Node, no Electron) so the web build
// can use the same code. This file only maps IPC channels onto it, supplies the
// per-window workspace folder, and keeps the cache under app userData.
//
// Registered from main.js inside the clawscad:anchor:modules block, like every
// other package: `register(ipcMain, deps)`.
'use strict';

const path = require('path');
const { createFinderFromEnv } = require('./finder/index.js');

// Only these hosts may be opened in the user's browser from a model page.
const EXTERNAL_HOSTS = [/(^|\.)makerworld\.com$/i, /(^|\.)printables\.com$/i, /(^|\.)bambulab\.com$/i, /(^|\.)creativecommons\.org$/i];

function isAllowedExternal(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && EXTERNAL_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

exports.register = function register(ipcMain, deps) {
  const { getCtx, addCheckpoint, app } = deps;
  const finder = createFinderFromEnv({ cacheDir: path.join(app.getPath('userData'), 'finder-cache'), printing: true });

  const workspaceOf = (event) => {
    const ctx = getCtx(event);
    return ctx && ctx.workspaceDir ? { ctx, workspaceDir: ctx.workspaceDir } : null;
  };
  const noWorkspace = () => ({ ok: false, error: { code: 'no-workspace', message: 'No workspace is open in this window.' } });
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  ipcMain.handle('finder:capabilities', () => finder.capabilities());
  ipcMain.handle('finder:search', (_e, opts) => finder.search(obj(opts)));
  ipcMain.handle('finder:detail', (_e, opts) => finder.detail(obj(opts)));
  ipcMain.handle('finder:job', (_e, jobId) => finder.job(jobId));

  ipcMain.handle('finder:download', (event, opts) => {
    const w = workspaceOf(event);
    return w ? finder.download({ ...obj(opts), workspaceDir: w.workspaceDir }) : noWorkspace();
  });

  ipcMain.handle('finder:open', (event, opts) => {
    const w = workspaceOf(event);
    if (!w) return noWorkspace();
    return finder.open({ ...obj(opts), workspaceDir: w.workspaceDir, addCheckpoint: (scadPath) => addCheckpoint(w.ctx, scadPath) });
  });

  ipcMain.handle('finder:printer-status', (_e, opts) => finder.printerStatus(obj(opts)));

  ipcMain.handle('finder:printer-snapshot', (event) => {
    const w = workspaceOf(event);
    return w ? finder.printerSnapshot({ workspaceDir: w.workspaceDir }) : noWorkspace();
  });

  ipcMain.handle('finder:print-prepare', (event, opts) => {
    const w = workspaceOf(event);
    return w ? finder.printPrepare({ ...obj(opts), workspaceDir: w.workspaceDir }) : noWorkspace();
  });

  ipcMain.handle('finder:print-start', (event, opts) => {
    const w = workspaceOf(event);
    return w ? finder.printStart({ ...obj(opts), workspaceDir: w.workspaceDir }) : noWorkspace();
  });

  ipcMain.handle('finder:open-external', async (_e, url) => {
    if (typeof url !== 'string' || !isAllowedExternal(url)) return false;
    const { shell } = require('electron');
    await shell.openExternal(url);
    return true;
  });
};

exports._internal = { isAllowedExternal };
