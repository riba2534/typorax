import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '5189', '--strictPort'], { cwd: root, stdio: 'ignore' });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error('Screenshot preview server exited');
    try { ready = (await fetch('http://127.0.0.1:5189')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Screenshot preview server did not start');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:5189');
  await page.waitForFunction(() => window.__typoraxReady === true);
  await page.locator('.brand-mark').evaluate(image => image.decode());
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(resolve(root, 'docs/images'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'docs/images/typorax.png'), animations: 'disabled' });
  await page.locator('#theme-toggle').click();
  await page.locator('#toggle-source').click();
  await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(root, 'docs/images/typorax-source-dark.png'), animations: 'disabled' });
  console.log('Captured actual production UI screenshots.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
