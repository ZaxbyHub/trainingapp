// Runtime smoke for PRR95-001: launches the REAL Electron binary with the
// REAL compiled preload (dist/preload/index.cjs) in a sandboxed, isolated
// window, and asserts the contextBridge actually attached. The vitest suite
// cannot catch this class of defect (it imports the TS source through a stub),
// so this smoke is the only end-to-end proof that the bridge works.
//
// Run from desktop/: `node_modules/.bin/electron scripts/preload-runtime-smoke.cjs`
// Exit 0 = bridge attached; exit 1 = failure (with diagnostic on stderr).
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'dist', 'preload', 'index.cjs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      preload: PRELOAD,
    },
  });
  try {
    await win.loadURL('data:text/html,<html><body>preload-smoke</body></html>');
    const bridgeType = await win.webContents.executeJavaScript(
      'typeof window.trainingapp',
      true,
    );
    if (bridgeType === 'object') {
      console.log(`[preload-runtime-smoke] OK: window.trainingapp attached (${PRELOAD})`);
      app.exit(0);
    } else {
      console.error(`[preload-runtime-smoke] FAIL: window.trainingapp is ${bridgeType}, expected object`);
      app.exit(1);
    }
  } catch (err) {
    console.error(`[preload-runtime-smoke] FAIL: ${err && err.message ? err.message : err}`);
    app.exit(1);
  }
});
