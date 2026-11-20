// main/studio-link.js — the desktop app's link to the ClawSCAD Studio server
// (v0.9).
//
// The web port (web/server.js, clawscad.dvlce.ca) runs on the studio machine
// against the same workspace the desktop app opens. Builds started in the web
// app run THERE, headless, and until now the desktop app could not see them.
// The link lets the desktop renderer talk to that server with the same fetch
// shim the web app uses: it shows the live build chat, starts builds that the
// web app can follow, offers the Customize view, and can hand a build's Claude
// session to the desktop terminal (`claude --resume <id>`) for full control.
//
// How: the renderer is a file:// page, so a fetch to http://127.0.0.1:8730 is
// cross-origin. The server sends no CORS headers on purpose — it has no auth,
// and a CORS header would let any web page in the user's own browser drive it.
// Instead this module adds the headers INSIDE Electron's session only, for the
// link's origin only. Browsers never see them.

'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8730';

function linkUrl() {
  const raw = String(process.env.CLAWSCAD_STUDIO_URL || DEFAULT_URL).trim();
  // `off` turns the link off: Make it goes to the terminal, no chat, no Customize.
  if (/^(off|none|0|false)$/i.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_URL;
    return u.origin;
  } catch {
    return DEFAULT_URL;
  }
}

function installCors(session, origin) {
  const filter = { urls: [`${origin}/*`] };
  session.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = { ...details.responseHeaders };
    // Header names arrive in mixed case; drop any existing copy first.
    for (const k of Object.keys(headers)) {
      if (/^access-control-allow-/i.test(k)) delete headers[k];
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = ['Content-Type'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, HEAD, OPTIONS'];
    // The server answers OPTIONS with 404; a preflight needs a 2xx.
    if (details.method === 'OPTIONS') {
      callback({ responseHeaders: headers, statusLine: 'HTTP/1.1 204 No Content' });
      return;
    }
    callback({ responseHeaders: headers });
  });
}

function register(ipcMain, { app, session }) {
  const origin = linkUrl();
  if (origin) {
    const ready = () => installCors(session.defaultSession, origin);
    if (app.isReady()) ready();
    else app.whenReady().then(ready);
  }

  ipcMain.handle('link:info', () => ({ url: origin }));

  // Customize's export: a cross-origin <a download> would navigate the window
  // away. downloadURL opens the normal Save dialog instead.
  ipcMain.handle('link:download', (event, url) => {
    if (!origin || typeof url !== 'string' || !url.startsWith(`${origin}/api/model/download?`)) return false;
    event.sender.downloadURL(url);
    return true;
  });
}

module.exports = { register, linkUrl, DEFAULT_URL };
