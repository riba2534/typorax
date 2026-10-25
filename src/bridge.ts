export type NativeDocument = { id: string; path: string | null; name: string; content: string };
export type Folder = { path: string; name: string; files: { path: string; name: string }[] };
declare global {
  interface Window {
    webkit?: { messageHandlers: { typorax?: { postMessage: (body: unknown) => void } } };
    __typoraxResolve: (response: { id: string; result?: any; error?: string }) => void;
    __typoraxCommand: (command: string) => void;
  }
}
export const native = !!window.webkit?.messageHandlers.typorax;
const pending = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void }>();
window.__typoraxResolve = response => {
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  if (response.error) request.reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error)));
  else request.resolve(response.result);
};
export async function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!native) return browserCall(method, params);
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { window.webkit!.messageHandlers.typorax!.postMessage({ id, method, params }); }
    catch (error) { pending.delete(id); reject(error); }
  });
}
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
async function browserCall(method: string, params: Record<string, any>): Promise<any> {
  switch (method) {
    case 'bootstrap': return { documents: [], folder: null };
    case 'openFile': {
      const file = await pickFile('.md,.markdown,.mdown,.txt');
      return file ? { id: crypto.randomUUID(), path: null, name: file.name, content: await file.text() } : null;
    }
    case 'saveFile':
      download(params.content, params.name || 'Untitled.md', 'text/markdown;charset=utf-8');
      return { path: null, name: params.name || 'Untitled.md' };
    case 'exportHTML':
      download(params.html, params.name.replace(/\.md$/i, '') + '.html', 'text/html;charset=utf-8');
      return { path: '下载目录' };
    case 'exportPDF': window.print(); return { path: '打印 / 存储为 PDF' };
    case 'chooseImage': {
      const file = await pickFile('image/png,image/jpeg,image/gif,image/webp');
      if (!file) return null;
      const url = await fileDataURL(file);
      return { url, markdownPath: url };
    }
    case 'setDirty': case 'closeConfirmed': return null;
    case 'openFolder': throw new Error('文件夹工作区在 macOS 桌面应用中可用。浏览器预览可打开单个文件。');
    case 'revealFile': return null;
    default: throw new Error('此操作需要 TyporaX macOS 应用：' + method);
  }
}
export async function fileDataURL(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片');
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MiB');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}
