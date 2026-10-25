import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const visual = (page: Page) => page.locator('#editor [contenteditable="true"]');
const source = (page: Page) => page.locator('#source-editor .cm-content');

async function start(page: Page) {
  await page.goto('/');
  await expect(page.locator('#document-name')).not.toHaveText('未命名文档');
  await expect(visual(page)).toBeVisible();
}

async function openMarkdown(page: Page, content: string, name = 'example.md') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开 Markdown 文件', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  await expect(page.locator('#document-name')).toHaveText(name);
}

async function menu(page: Page, action: string) {
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.locator(`[data-action="${action}"]`).click();
}

async function download(page: Page, action: 'save' | 'exportHTML') {
  const pending = page.waitForEvent('download');
  await menu(page, action);
  const file = await pending;
  const path = await file.path();
  expect(path).not.toBeNull();
  return { name: file.suggestedFilename(), content: await readFile(path!, 'utf8') };
}

async function setSource(page: Page, text: string) {
  if (!await source(page).isVisible()) await page.locator('#toggle-source').click();
  await source(page).fill(text);
}

test('typing Markdown immediately produces a heading and bold text', async ({ page }) => {
  await start(page);
  await page.locator('#new-document').click();
  await visual(page).pressSequentially('# A new heading');
  await expect(visual(page).locator('h1')).toHaveText('A new heading');
  await visual(page).press('Enter');
  await visual(page).pressSequentially('**strong words** ');
  await expect(visual(page).locator('strong')).toHaveText('strong words');
  await page.locator('#toggle-source').click();
  await expect(source(page)).toContainText('# A new heading');
  await expect(source(page)).toContainText('**strong words**');
});

test('source and visual round trips retain headings, tasks, tables, and math', async ({ page }) => {
  await start(page);
  const markdown = '# Round trip\n\n- [x] Completed\n- [ ] Pending\n\n| Name | Value |\n| --- | --- |\n| alpha | 42 |\n\nInline $E=mc^2$.\n\n$$\na^2+b^2=c^2\n$$\n';
  await openMarkdown(page, markdown);
  for (let round = 0; round < 2; round++) {
    await expect(visual(page).locator('h1')).toHaveText('Round trip');
    await expect(visual(page).locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(visual(page).locator('input[type="checkbox"]').first()).toBeChecked();
    await expect(visual(page).locator('input[type="checkbox"]').last()).not.toBeChecked();
    await expect(visual(page).locator('table')).toContainText('alpha');
    await expect(visual(page).locator('table')).toContainText('42');
    await expect(visual(page).locator('.katex')).toHaveCount(2);
    await page.locator('#toggle-source').click();
    await expect(source(page)).toContainText('a^2+b^2=c^2');
    await expect(source(page)).toContainText('- [x] Completed');
    await page.locator('#toggle-source').click();
    await expect(visual(page)).toBeVisible();
  }
  await visual(page).locator('input[type="checkbox"]').last().check();
  const saved = await download(page, 'save');
  expect(saved.content).toContain('- [x] Pending');
  expect(saved.content).toContain('E=mc^2');
  expect(saved.content).toContain('a^2+b^2=c^2');
  expect(saved.content).toMatch(/\|\s*alpha\s*\|\s*42\s*\|/);
});

test('unsaved drafts survive a page reload', async ({ page }) => {
  await start(page);
  await page.locator('#new-document').click();
  const draft = '# Reload draft\n\n中文内容 remains unsaved.';
  await setSource(page, draft);
  await expect(page.locator('#save-indicator')).toHaveText('未保存');
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#document-name')).toHaveText('未命名.md');
  await expect(visual(page)).toContainText('中文内容 remains unsaved.');
  await page.locator('#toggle-source').click();
  await expect(source(page)).toContainText('# Reload draft');
  expect((await download(page, 'save')).content).toBe(draft);
});

for (const mode of ['visual', 'source'] as const) {
  test(`find and replace updates exactly the matching text in ${mode} mode`, async ({ page }) => {
    await start(page);
    await openMarkdown(page, '# Search\n\nApple apple pineapple.\n\nUntouched paragraph.');
    if (mode === 'source') await page.locator('#toggle-source').click();
    await page.keyboard.press('ControlOrMeta+f');
    await page.getByRole('searchbox', { name: '查找文字', exact: true }).fill('apple');
    await expect(page.locator('#find-count')).toHaveText('3 处匹配');
    await page.getByRole('textbox', { name: '替换为', exact: true }).fill('pear');
    await page.locator('#find-next').click();
    await expect(page.locator('#find-count')).toHaveText('1 / 3');
    await page.locator('#replace-one').click();
    await expect(page.locator('#find-count')).toHaveText('1 / 2');
    await page.locator('#replace-all').click();
    await expect(page.locator('#find-count')).toHaveText('无匹配');
    const content = (await download(page, 'save')).content;
    expect(content).toContain('pear pear pinepear.');
    expect(content).toContain('Untouched paragraph.');
    expect(content).toContain('# Search');
  });
}

test('browser save and HTML export contain the current document', async ({ page }) => {
  await start(page);
  await openMarkdown(page, '# Exported\n\nA **bold** statement.\n', 'export-check.md');
  const saved = await download(page, 'save');
  expect(saved.name).toBe('export-check.md');
  expect(saved.content).toBe('# Exported\n\nA **bold** statement.\n');
  const exported = await download(page, 'exportHTML');
  expect(exported.name).toBe('export-check.html');
  await page.setContent(exported.content);
  await expect(page.locator('h1')).toHaveText('Exported');
  await expect(page.locator('strong')).toHaveText('bold');
  await expect(page.locator('#format-toolbar')).toHaveCount(0);
});

for (const [syntax, markdown] of [
  ['frontmatter', '---\r\ntitle: "Keep this"\r\ncustom: [1, 2]\r\n---\r\n\r\n# Original\r\n'],
  ['raw HTML', '<section class="custom">Keep <span>every tag</span>.</section>\n\n# Original\n'],
  ['footnotes', '# Original\n\nKeep the note[^note].\n\n[^note]: exact footnote text\n'],
] as const) {
  test(`${syntax} opens in source mode and saves without changing bytes`, async ({ page }) => {
    await start(page);
    await openMarkdown(page, markdown, 'preserved.md');
    await expect(source(page)).toBeVisible();
    await expect(visual(page)).toBeHidden();
    await page.locator('#toggle-source').click();
    await expect(source(page)).toBeVisible();
    const saved = await download(page, 'save');
    expect(saved.content).toBe(markdown);
  });
}

test('script-bearing Markdown remains inert while opening, editing, and exporting', async ({ page }) => {
  await start(page);
  const malicious = '# Inert\n\n<img src=x onerror="window.__testExecuted=true">\n<script>window.__testExecuted=true</script>\n';
  await openMarkdown(page, malicious, 'inert.md');
  await expect(source(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => '__testExecuted' in window)).toBe(false);
  await source(page).press('ControlOrMeta+End');
  await source(page).press('Enter');
  await source(page).pressSequentially('Still editable');
  const saved = await download(page, 'save');
  expect(saved.content).toContain('<script>window.__testExecuted=true</script>');
  expect(saved.content).toContain('Still editable');
  const exported = await download(page, 'exportHTML');
  await page.setContent(exported.content);
  await expect(page.locator('body')).toContainText('<script>window.__testExecuted=true</script>');
  expect(await page.evaluate(() => '__testExecuted' in window)).toBe(false);
  await expect(page.locator('script')).toHaveCount(0);
});

test('Mermaid renders a real SVG in the editor and exported HTML', async ({ page }) => {
  await start(page);
  await openMarkdown(page, '# Diagram\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```\n');
  await expect(visual(page).locator('.diagram-preview svg')).toBeVisible();
  await expect(visual(page).locator('.diagram-preview')).toContainText('Start');
  await expect(visual(page).locator('.diagram-preview')).toContainText('Finish');
  const exported = await download(page, 'exportHTML');
  await page.setContent(exported.content);
  await expect(page.locator('svg')).toBeVisible();
  await expect(page.locator('svg')).toContainText('Start');
  await expect(page.locator('svg')).toContainText('Finish');
});

test('dark theme persists and a narrow editor stays inside the viewport', async ({ page }) => {
  await start(page);
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(visual(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await visual(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  await page.locator('#toggle-source').click();
  await expect(source(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('native bridge bootstraps a document and receives edited content on save', async ({ page }) => {
  await page.addInitScript(() => {
    const messages: { id: string; method: string; params: Record<string, unknown> }[] = [];
    const host = window as any;
    host.__nativeMessages = messages;
    const bridge = { postMessage(message: typeof messages[number]) {
      messages.push(message);
      const result = message.method === 'bootstrap'
        ? { documents: [{ id: 'native-doc', path: '/test/bridge.md', name: 'bridge.md', content: '# Native boot\n' }], folder: null }
        : message.method === 'saveFile' ? { path: '/test/bridge.md', name: 'bridge.md' } : null;
      queueMicrotask(() => (host.__typoraxResolve)({ id: message.id, result }));
    } };
    host.webkit = { messageHandlers: { typorax: bridge } };
  });
  await start(page);
  await expect(page.locator('#document-name')).toHaveText('bridge.md');
  await expect(visual(page).locator('h1')).toHaveText('Native boot');
  const edited = '# Native saved\n\nContent from the actual editing surface.';
  await setSource(page, edited);
  await menu(page, 'save');
  await expect(page.locator('#save-indicator')).toHaveText('已保存');
  const requests = await page.evaluate(() => (window as any).__nativeMessages);
  expect(requests.filter((request: any) => request.method === 'bootstrap')).toHaveLength(1);
  expect(requests.filter((request: any) => request.method === 'saveFile').map((request: any) => request.params)).toEqual([
    { id: 'native-doc', path: '/test/bridge.md', name: 'bridge.md', content: edited, saveAs: false },
  ]);
});

test('source find and replace handles Chinese text without altering nearby content', async ({ page }) => {
  await start(page);
  await openMarkdown(page, '# 中文查找\n\n写作让思路清晰。今天继续写作。\n\n保持这段原文。');
  await page.locator('#toggle-source').click();
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: '查找文字', exact: true }).fill('写作');
  await expect(page.locator('#find-count')).toHaveText('2 处匹配');
  await page.getByRole('textbox', { name: '替换为', exact: true }).fill('记录想法');
  await page.locator('#replace-all').click();
  await expect(page.locator('#find-count')).toHaveText('无匹配');
  const saved = await download(page, 'save');
  expect(saved.content).toBe('# 中文查找\n\n记录想法让思路清晰。今天继续记录想法。\n\n保持这段原文。');
});

test('a dirty native draft becomes a recovery copy when its disk file changed', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__nativeMessages = [];
    const diskKey = 'test.native.disk';
    if (sessionStorage.getItem(diskKey) === null) sessionStorage.setItem(diskKey, '# Original disk file\n');
    const diskDocument = () => ({ id: '/test/original.md', path: '/test/original.md', name: 'original.md', content: sessionStorage.getItem(diskKey)! });
    const bridge = { postMessage(message: { id: string; method: string; params: Record<string, any> }) {
      host.__nativeMessages.push(message);
      let result: any = null;
      if (message.method === 'bootstrap') result = { documents: [diskDocument()], folder: null };
      if (message.method === 'readFile') result = diskDocument();
      if (message.method === 'saveFile') {
        if (message.params.path === '/test/original.md') {
          sessionStorage.setItem(diskKey, message.params.content);
          result = { path: '/test/original.md', name: 'original.md' };
        } else {
          sessionStorage.setItem('test.native.recovery', message.params.content);
          result = { path: '/test/recovered.md', name: 'recovered.md' };
        }
      }
      queueMicrotask(() => (host.__typoraxResolve)({ id: message.id, result }));
    } };
    host.webkit = { messageHandlers: { typorax: bridge } };
  });
  await start(page);
  await setSource(page, '# Last saved version\n');
  await menu(page, 'save');
  await expect(page.locator('#save-indicator')).toHaveText('已保存');
  const draft = '# Unsaved recovery\n\nDo not lose this draft.';
  await setSource(page, draft);
  await expect(page.locator('#save-indicator')).toHaveText('未保存');
  // This is the host's fake disk, not the editor state: simulate an external writer.
  const external = '# External disk edit\n\nWritten by another application.\n';
  await page.evaluate(value => sessionStorage.setItem('test.native.disk', value), external);
  await page.reload();
  await expect(page.locator('#document-name')).toHaveText('original（恢复副本）.md');
  await expect(visual(page)).toContainText('Do not lose this draft.');
  await expect(page.locator('#file-list')).toContainText('original');
  await menu(page, 'save');
  await expect(page.locator('#save-indicator')).toHaveText('已保存');
  const result = await page.evaluate(() => ({
    disk: sessionStorage.getItem('test.native.disk'),
    recovery: sessionStorage.getItem('test.native.recovery'),
    requests: (window as any).__nativeMessages,
  }));
  expect(result.disk).toBe(external);
  expect(result.recovery).toBe(draft);
  expect(result.requests.filter((request: any) => request.method === 'readFile')).toHaveLength(1);
  const saves = result.requests.filter((request: any) => request.method === 'saveFile');
  expect(saves).toHaveLength(1);
  expect(saves[0].params.path).toBeNull();
  expect(saves[0].params.content).toBe(draft);
});

test('reopening a changed disk file preserves the dirty document as a separate recovery copy', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__nativeMessages = [];
    host.__nativeDisk = '# Original disk version\n';
    const diskDocument = () => ({ id: '/test/reopen.md', path: '/test/reopen.md', name: 'reopen.md', content: host.__nativeDisk });
    const bridge = { postMessage(message: { id: string; method: string; params: Record<string, any> }) {
      host.__nativeMessages.push(message);
      let result: any = null;
      if (message.method === 'bootstrap') result = { documents: [diskDocument()], folder: null };
      if (message.method === 'openFile') result = diskDocument();
      if (message.method === 'saveFile') {
        if (message.params.path) host.__nativeDisk = message.params.content;
        else host.__nativeRecovery = message.params.content;
        result = { path: message.params.path || '/test/recovered.md', name: message.params.path ? 'reopen.md' : 'recovered.md' };
      }
      queueMicrotask(() => (host.__typoraxResolve)({ id: message.id, result }));
    } };
    host.webkit = { messageHandlers: { typorax: bridge } };
  });
  await start(page);
  // Reopening an unchanged editor first refreshes it from the external writer.
  await page.evaluate(() => { (window as any).__nativeDisk = '# New disk version\n'; });
  await page.getByRole('button', { name: '打开 Markdown 文件', exact: true }).click();
  await expect(visual(page).locator('h1')).toHaveText('New disk version');
  await expect(page.locator('#file-list .file-item')).toHaveCount(1);
  const draft = '# Unsaved local work\n\nPreserve all of these changes.';
  await setSource(page, draft);
  const external = '# Another external update\n\nDisk content must survive.\n';
  await page.evaluate(value => { (window as any).__nativeDisk = value; }, external);
  await page.getByRole('button', { name: '打开 Markdown 文件', exact: true }).click();
  await expect(source(page)).toContainText('Disk content must survive.');
  await expect(page.locator('#file-list .file-item')).toHaveCount(2);
  await page.locator('#file-list .file-item').filter({ hasText: 'reopen（恢复副本）' }).click();
  await expect(source(page)).toContainText('Preserve all of these changes.');
  await expect(page.locator('#save-indicator')).toHaveText('未保存');
  await menu(page, 'save');
  await expect(page.locator('#save-indicator')).toHaveText('已保存');
  const result = await page.evaluate(() => ({
    disk: (window as any).__nativeDisk,
    recovery: (window as any).__nativeRecovery,
    saves: (window as any).__nativeMessages.filter((request: any) => request.method === 'saveFile'),
  }));
  expect(result.disk).toBe(external);
  expect(result.recovery).toBe(draft);
  expect(result.saves).toHaveLength(1);
  expect(result.saves[0].params.path).toBeNull();
  expect(result.saves[0].params.content).toBe(draft);
});

test('editing during an asynchronous save prevents native close confirmation', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__nativeMessages = [];
    const resolve = (id: string, result: unknown) => (host.__typoraxResolve)({ id, result });
    const bridge = { postMessage(message: { id: string; method: string; params: Record<string, any> }) {
      host.__nativeMessages.push(message);
      if (message.method === 'saveFile') {
        host.__pendingNativeSave = message;
        return;
      }
      const result = message.method === 'bootstrap'
        ? { documents: [{ id: 'async-save', path: '/test/async.md', name: 'async.md', content: '# Saved file\n' }], folder: null }
        : null;
      queueMicrotask(() => resolve(message.id, result));
    } };
    host.__finishNativeSave = () => {
      const request = host.__pendingNativeSave;
      delete host.__pendingNativeSave;
      resolve(request.id, { path: '/test/async.md', name: 'async.md' });
    };
    host.webkit = { messageHandlers: { typorax: bridge } };
  });
  await start(page);
  const first = '# Save in progress\n';
  const latest = '# Edited during save\n\nThis newer text is still unsaved.';
  await setSource(page, first);
  // Simulate the native window's Save-and-Close command through its public bridge.
  await page.evaluate(() => { const host = window as any; (host.__typoraxCommand)('saveAndClose'); });
  await expect.poll(() => page.evaluate(() => (window as any).__pendingNativeSave?.params.content)).toBe(first);
  await source(page).fill(latest);
  await page.evaluate(() => (window as any).__finishNativeSave());
  await expect(page.locator('#toast')).toContainText('保存期间内容又有更新');
  await expect(page.locator('#save-indicator')).toHaveText('未保存');
  await expect(source(page)).toContainText('This newer text is still unsaved.');
  expect(await page.evaluate(() => (window as any).__nativeMessages.filter((request: any) => request.method === 'closeConfirmed'))).toHaveLength(0);
  // A second completed save can close, establishing that the first close was deferred.
  await page.evaluate(() => { const host = window as any; (host.__typoraxCommand)('saveAndClose'); });
  await expect.poll(() => page.evaluate(() => (window as any).__pendingNativeSave?.params.content)).toBe(latest);
  await page.evaluate(() => (window as any).__finishNativeSave());
  await expect.poll(() => page.evaluate(() => (window as any).__nativeMessages.filter((request: any) => request.method === 'closeConfirmed').length)).toBe(1);
  await expect(page.locator('#save-indicator')).toHaveText('已保存');
});

for (const mode of ['visual', 'source'] as const) {
  test(`undo stays inside the current document in ${mode} mode`, async ({ page }) => {
    await start(page);
    await openMarkdown(page, '# Alpha private\n\nOriginal alpha content.', 'alpha.md');
    if (mode === 'source') await page.locator('#toggle-source').click();
    const surface = mode === 'visual' ? visual(page) : source(page);
    await surface.press('ControlOrMeta+End');
    await surface.pressSequentially(' Alpha unsaved change.');
    await expect(surface).toContainText('Alpha unsaved change.');

    await page.locator('#new-document').click();
    await expect(page.locator('#document-name')).toHaveText('未命名.md');
    await surface.pressSequentially('# Beta fresh');
    await surface.press('Enter');
    await surface.pressSequentially('Only beta editing.');
    await expect(surface).toContainText('Only beta editing.');
    for (let step = 0; step < 6; step++) {
      await surface.press('ControlOrMeta+z');
      await expect(surface).not.toContainText('Alpha');
      await expect(surface).not.toContainText('Original alpha content.');
    }
    await expect(surface).toHaveText('');

    await surface.pressSequentially('# Beta retained');
    await surface.press('Enter');
    await surface.pressSequentially('This belongs to beta.');
    const betaContent = (await download(page, 'save')).content;
    await page.locator('#file-list .file-item').filter({ hasText: 'alpha' }).click();
    await expect(surface).toContainText('Alpha unsaved change.');
    await surface.press('ControlOrMeta+End');
    await surface.pressSequentially(' Another alpha edit.');
    await page.locator('#file-list .file-item').filter({ hasText: '未命名' }).click();
    await expect(surface).toContainText('This belongs to beta.');
    await surface.press('ControlOrMeta+End');
    await surface.pressSequentially(' Beta follow-up.');
    await surface.press('ControlOrMeta+z');
    expect((await download(page, 'save')).content).toBe(betaContent);
    // Exhausting the newly loaded history must not undo loading a different file.
    for (let step = 0; step < 3; step++) await surface.press('ControlOrMeta+z');
    expect((await download(page, 'save')).content).toBe(betaContent);
    await expect(surface).not.toContainText('alpha');
  });
}

test('toolbar headings and text marks format the selection and serialize it', async ({ page }) => {
  await start(page);
  await page.locator('#new-document').click();
  await visual(page).fill('Toolbar content');
  for (const level of [1, 2, 3]) {
    await page.locator(`[data-format="heading${level}"]`).click();
    await expect(visual(page).locator(`h${level}`)).toHaveText('Toolbar content');
    await expect(page.locator(`[data-format="heading${level}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
  await visual(page).press('ControlOrMeta+a');
  for (const [format, tag] of [['bold', 'strong'], ['italic', 'em'], ['strike', 's']]) {
    await page.locator(`[data-format="${format}"]`).click();
    await expect(visual(page).locator(tag)).toHaveText('Toolbar content');
  }
  const markdown = (await download(page, 'save')).content;
  expect(markdown).toMatch(/^### /);
  expect(markdown).toContain('**');
  expect(markdown).toContain('~~');
  await page.locator('#toggle-source').click();
  await page.locator('#toggle-source').click();
  await expect(visual(page).locator('h3 strong em s, h3 strong s em, h3 em strong s, h3 em s strong, h3 s strong em, h3 s em strong')).toHaveText('Toolbar content');
});

test('toolbar lists, quotes, code blocks, and horizontal rules change document structure', async ({ page }) => {
  await start(page);
  for (const [format, selector, markdown] of [
    ['bulletList', 'ul:not([data-type="taskList"]) li', '- Block text'],
    ['orderedList', 'ol li', '1. Block text'],
    ['taskList', 'li:has(input[type="checkbox"])', '- [ ] Block text'],
    ['blockquote', 'blockquote', '> Block text'],
    ['codeBlock', 'pre code', '```'],
  ]) {
    await page.locator('#new-document').click();
    await visual(page).fill('Block text');
    await page.locator(`[data-format="${format}"]`).click();
    await expect(visual(page).locator(selector)).toContainText('Block text');
    expect((await download(page, 'save')).content).toContain(markdown);
  }
  await page.locator('#new-document').click();
  await visual(page).fill('Before divider');
  await page.locator('[data-format="horizontalRule"]').click();
  await expect(visual(page).locator('hr')).toHaveCount(1);
  expect((await download(page, 'save')).content).toContain('---');
});

test('link dialogs confirm, cancel, escape, and reject unsafe URLs without losing text', async ({ page }) => {
  await start(page);
  await page.locator('#new-document').click();
  await visual(page).fill('Selected label');
  await visual(page).press('ControlOrMeta+a');
  await page.locator('[data-format="link"]').click();
  await page.locator('#dialog-input').fill('https://example.com/original');
  await page.locator('#dialog-confirm').click();
  const link = visual(page).locator('a');
  await expect(link).toHaveAttribute('href', 'https://example.com/original');
  await expect(link).toHaveText('Selected label');
  for (const cancellation of ['button', 'escape']) {
    await link.click();
    await page.locator('[data-format="link"]').click();
    await page.locator('#dialog-input').fill('https://example.com/cancelled');
    if (cancellation === 'button') await page.locator('#dialog-cancel').click();
    else await page.locator('#dialog-input').press('Escape');
    await expect(page.locator('#input-dialog')).not.toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://example.com/original');
  }
  await link.click();
  await page.locator('[data-format="link"]').click();
  await page.locator('#dialog-input').fill('javascript:alert(1)');
  await page.locator('#dialog-confirm').click();
  await expect(page.locator('#toast')).toContainText('链接需以');
  await expect(link).toHaveAttribute('href', 'https://example.com/original');
  await link.click();
  await page.locator('[data-format="link"]').click();
  await page.locator('#dialog-input').fill('');
  await page.locator('#dialog-confirm').click();
  await expect(link).toHaveCount(0);
  await expect(visual(page)).toHaveText('Selected label');
});

test('table toolbar inserts editable cells and preserves their values on source round trips', async ({ page }) => {
  await start(page);
  await page.locator('#new-document').click();
  await page.locator('[data-format="table"]').click();
  const table = visual(page).locator('table');
  await expect(table.locator('tr')).toHaveCount(3);
  await table.locator('th').first().click();
  await page.keyboard.type('Item');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Count');
  await table.locator('td').first().click();
  await page.keyboard.type('Apples');
  await page.keyboard.press('Tab');
  await page.keyboard.type('12');
  await page.locator('#toggle-source').click();
  await expect(source(page)).toContainText('Apples');
  await page.locator('#toggle-source').click();
  await expect(table.locator('th').first()).toHaveText('Item');
  await expect(table.locator('td').first()).toHaveText('Apples');
  expect((await download(page, 'save')).content).toMatch(/\| Apples\s*\| 12\s*\|/);
});

test('math dialogs edit inline and block formulas and export the changed equations', async ({ page }) => {
  await start(page);
  await openMarkdown(page, 'Inline $x+1$.\n\n$$\ny^2\n$$\n');
  const math = visual(page).locator('.tiptap-mathematics-render .katex-html');
  await math.first().click();
  await expect(page.locator('#dialog-input')).toHaveValue('x+1');
  await page.locator('#dialog-input').fill('x+2');
  await page.locator('#dialog-input').press('Enter');
  await math.last().click();
  await page.locator('#dialog-input').fill('z^3');
  await page.locator('#dialog-confirm').click();
  await math.last().click();
  await page.locator('#dialog-input').fill('cancelled');
  await page.locator('#dialog-input').press('Escape');
  const saved = (await download(page, 'save')).content;
  expect(saved).toContain('$x+2$');
  expect(saved).toContain('z^3');
  expect(saved).not.toContain('cancelled');
  const exported = await download(page, 'exportHTML');
  await page.setContent(exported.content);
  await expect(page.locator('.katex')).toHaveCount(2);
  await expect(page.locator('annotation').first()).toHaveText('x+2');
  await expect(page.locator('annotation').last()).toHaveText('z^3');
});

const tinyPNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
for (const mode of ['visual', 'source'] as const) {
  test(`image insertion in ${mode} mode remains visible and exports a self-contained image`, async ({ page }) => {
    await start(page);
    await page.locator('#new-document').click();
    if (mode === 'source') await page.locator('#toggle-source').click();
    const picker = page.waitForEvent('filechooser');
    await menu(page, 'insertImage');
    await (await picker).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(tinyPNG, 'base64') });
    if (mode === 'source') {
      await expect(source(page)).toContainText('data:image/png;base64,');
      await page.locator('#toggle-source').click();
    }
    const img = visual(page).locator('img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
    expect((await download(page, 'save')).content).toContain(tinyPNG);
    const exported = await download(page, 'exportHTML');
    await page.setContent(exported.content);
    await expect(page.locator('img')).toHaveAttribute('src', 'data:image/png;base64,' + tinyPNG);
    await expect.poll(() => page.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  });
}

test('file filtering, outline navigation, and the sidebar preserve the current document', async ({ page }) => {
  await start(page);
  const padding = Array.from({ length: 35 }, (_, index) => 'Paragraph ' + index + '.').join('\n\n');
  await openMarkdown(page, '# First heading\n\n' + padding + '\n\n## Last heading\n\nTail text.', 'outline.md');
  await page.locator('#file-search').fill('OUTLINE');
  await expect(page.locator('#file-list .file-item')).toHaveCount(1);
  await page.locator('#file-search').fill('does-not-exist');
  await expect(page.locator('#file-list')).toHaveText('没有匹配的文档');
  await page.locator('#file-search').fill('');
  await page.getByRole('tab', { name: '大纲', exact: true }).click();
  await expect(page.locator('#outline-list button')).toHaveText(['First heading', 'Last heading']);
  await page.locator('#outline-list button').last().click();
  await expect(visual(page).locator('h2')).toBeInViewport();
  await page.locator('#toggle-source').click();
  await page.locator('#outline-list button').first().click();
  await expect(page.locator('#cursor-position')).toHaveText('Ln 1, Col 1');
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#document-name')).toHaveText('outline.md');
});

test('outline follows actual headings and ignores different fence markers inside code', async ({ page }) => {
  await start(page);
  await openMarkdown(page, 'Setext heading\n==============\n\n~~~markdown\n# In code\n```\n# Still in code\n~~~\n\n## Real heading\n');
  await page.getByRole('tab', { name: '大纲', exact: true }).click();
  await expect(page.locator('#outline-list button')).toHaveText(['Setext heading', 'Real heading']);
  await page.locator('#outline-list button').last().click();
  await expect(visual(page).locator('h2')).toBeInViewport();
});

test('focus, typewriter, themes, and shortcut dialogs respond to their controls', async ({ page }) => {
  await start(page);
  await page.locator('#focus-mode').click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.locator('#focus-mode')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#focus-mode')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#focus-mode')).not.toHaveClass(/active/);
  await page.locator('#more-menu-toggle').click();
  await expect(page.locator('#more-menu-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#more-menu-toggle')).toHaveAttribute('aria-expanded', 'false');
  await menu(page, 'typewriter');
  await expect(page.locator('[data-action="typewriter"]')).toHaveAttribute('aria-checked', 'true');
  const typewriterPadding = await page.locator('#editor').evaluate(element => parseFloat(getComputedStyle(element).paddingTop));
  expect(typewriterPadding).toBeGreaterThan(200);
  await menu(page, 'typewriter');
  await expect(page.locator('[data-action="typewriter"]')).toHaveAttribute('aria-checked', 'false');
  expect(await page.locator('#editor').evaluate(element => parseFloat(getComputedStyle(element).paddingTop))).toBeLessThan(typewriterPadding);
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await menu(page, 'shortcuts');
  await expect(page.locator('#shortcuts-dialog')).toBeVisible();
  await page.locator('#close-shortcuts').click();
  await expect(page.locator('#shortcuts-dialog')).toBeHidden();
});

test('source search wraps backwards, treats punctuation literally, and supports deletion', async ({ page }) => {
  await start(page);
  await openMarkdown(page, 'one [x] two [x] three [x] end');
  await page.locator('#toggle-source').click();
  await page.keyboard.press('ControlOrMeta+f');
  await page.locator('#find-input').fill('[x]');
  await page.locator('#find-prev').click();
  await expect(page.locator('#find-count')).toHaveText('3 / 3');
  await page.locator('#find-next').click();
  await expect(page.locator('#find-count')).toHaveText('1 / 3');
  await page.locator('#replace-input').fill('');
  await page.locator('#replace-all').click();
  await expect(page.locator('#find-count')).toHaveText('无匹配');
  expect((await download(page, 'save')).content).toBe('one  two  three  end');
  await page.locator('#find-input').fill('');
  await page.locator('#replace-all').click();
  expect((await download(page, 'save')).content).toBe('one  two  three  end');
});

test('case-insensitive source replacement keeps Unicode offsets and surrounding text intact', async ({ page }) => {
  await start(page);
  await openMarkdown(page, 'İstanbul 😀 NAME name.');
  await page.locator('#toggle-source').click();
  await page.keyboard.press('ControlOrMeta+f');
  await page.locator('#find-input').fill('name');
  await expect(page.locator('#find-count')).toHaveText('2 处匹配');
  await page.locator('#replace-input').fill('word');
  await page.locator('#replace-all').click();
  expect((await download(page, 'save')).content).toBe('İstanbul 😀 word word.');
});

test('code language dialog updates saved fences and can cancel changes', async ({ page }) => {
  await start(page);
  await openMarkdown(page, '```javascript\nconst value = 1;\n```\n');
  await visual(page).locator('.code-language').click();
  await page.locator('#dialog-input').fill('typescript');
  await page.locator('#dialog-confirm').click();
  await expect(visual(page).locator('.code-language')).toHaveText('typescript');
  await visual(page).locator('.code-language').click();
  await page.locator('#dialog-input').fill('python');
  await page.locator('#dialog-cancel').click();
  expect((await download(page, 'save')).content).toContain('```typescript\nconst value = 1;');
});

test('native bootstrap activePath wins over restored selection and ready follows initialization', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    const old = { id: 'old-draft', path: null, name: 'old.md', content: '# Restored draft', savedContent: '', dirty: true };
    localStorage.setItem('typorax.documents.v1', JSON.stringify({ documents: [old], activeId: old.id }));
    host.webkit = { messageHandlers: { typorax: { postMessage(message: any) {
      const result = message.method === 'bootstrap' ? {
        documents: [{ id: 'finder', path: '/test/finder.md', name: 'finder.md', content: '# Finder requested file' }],
        folder: null, activePath: '/test/finder.md',
      } : null;
      if (message.method === 'ready') host.__readySnapshot = { name: document.querySelector('#document-name')?.textContent, ready: host.__typoraxReady };
      queueMicrotask(() => host.__typoraxResolve({ id: message.id, result }));
    } } } };
  });
  await start(page);
  await expect(visual(page).locator('h1')).toHaveText('Finder requested file');
  await expect.poll(() => page.evaluate(() => (window as any).__readySnapshot)).toEqual({ name: 'finder.md', ready: true });
  await page.locator('#file-list .file-item').filter({ hasText: 'old' }).click();
  await expect(visual(page)).toContainText('Restored draft');
});

test('cancelled native saves preserve dirty documents and Save-and-Close saves every document', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__nativeMessages = [];
    host.__cancelSave = true;
    host.webkit = { messageHandlers: { typorax: { postMessage(message: any) {
      host.__nativeMessages.push(message);
      let result: any = null;
      if (message.method === 'bootstrap') result = { documents: [], folder: null };
      if (message.method === 'saveFile' && !host.__cancelSave) result = { path: '/test/' + message.params.name, name: message.params.name };
      queueMicrotask(() => host.__typoraxResolve({ id: message.id, result }));
    } } } };
  });
  await start(page);
  await page.locator('#new-document').click();
  await setSource(page, '# First dirty draft');
  await menu(page, 'saveAs');
  await expect(page.locator('#save-indicator')).toHaveText('未保存');
  await expect(source(page)).toHaveText('# First dirty draft');
  const cancelled = await page.evaluate(() => (window as any).__nativeMessages.filter((message: any) => message.method === 'saveFile'));
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0].params.saveAs).toBe(true);
  await page.locator('#new-document').click();
  await setSource(page, '# Second dirty draft');
  await page.evaluate(() => (window as any).__typoraxCommand('saveAndClose'));
  await expect.poll(() => page.evaluate(() => (window as any).__nativeMessages.filter((message: any) => message.method === 'saveFile').length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__nativeMessages.some((message: any) => message.method === 'closeConfirmed'))).toBe(false);
  await page.evaluate(() => { (window as any).__cancelSave = false; (window as any).__typoraxCommand('saveAndClose'); });
  await expect.poll(() => page.evaluate(() => (window as any).__nativeMessages.filter((message: any) => message.method === 'closeConfirmed').length)).toBe(1);
  const completed = await page.evaluate(() => (window as any).__nativeMessages.filter((message: any) => message.method === 'saveFile').slice(2));
  expect(completed.map((message: any) => message.params.content)).toEqual(['# First dirty draft', '# Second dirty draft']);
  await expect(page.locator('#file-list .file-meta')).toHaveText(['md', 'md', 'md']);
});

test('folder workspace opens a listed file through the native bridge', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__nativeMessages = [];
    host.webkit = { messageHandlers: { typorax: { postMessage(message: any) {
      host.__nativeMessages.push(message);
      const result = message.method === 'bootstrap' ? { documents: [], folder: null }
        : message.method === 'openFolder' ? { path: '/test/workspace', name: 'workspace', truncated: true, files: [
          { path: '/test/workspace/first/note.md', name: 'note.md', relativePath: 'first/note.md' },
          { path: '/test/workspace/second/note.md', name: 'note.md', relativePath: 'second/note.md' },
        ] }
        : message.method === 'readFile' ? { id: 'workspace-note', path: message.params.path, name: 'note.md', content: '# Workspace note' } : null;
      queueMicrotask(() => host.__typoraxResolve({ id: message.id, result }));
    } } } };
  });
  await start(page);
  await page.locator('#open-folder').click();
  await expect(page.locator('#folder-label')).toHaveText('workspace');
  await expect(page.locator('#toast')).toContainText('文件列表已截断');
  await expect(page.locator('#file-list .file-name')).toContainText(['first/note', 'second/note']);
  await page.locator('#file-list .file-item').filter({ hasText: 'second/note' }).click();
  await expect(visual(page).locator('h1')).toHaveText('Workspace note');
  await expect(page.locator('#document-name')).toHaveText('note.md');
  await expect(page.locator('#file-list .is-active')).toContainText('second/note');
  expect(await page.evaluate(() => (window as any).__nativeMessages.find((message: any) => message.method === 'readFile').params.path)).toBe('/test/workspace/second/note.md');
});
