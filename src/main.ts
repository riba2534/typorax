import { Editor } from '@tiptap/core';
import { EditorState as ProseMirrorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Focus from '@tiptap/extension-focus';
import Mathematics from '@tiptap/extension-mathematics';
import { createLowlight, common } from 'lowlight';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { search, searchKeymap } from '@codemirror/search';
import { keymap } from '@codemirror/view';
import mermaid from 'mermaid';
import katex from 'katex';
import katexCSS from 'katex/dist/katex.min.css?inline';
import 'katex/dist/katex.min.css';
import './styles.css';
import './editor.css';
import { call, native, fileDataURL, type NativeDocument, type Folder } from './bridge';
import { WELCOME, statistics, outline, sourceOnlyReason, escapeHTML } from './document';

type DocumentState = NativeDocument & { savedContent: string; dirty: boolean };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE = 'typorax.documents.v1';
let documents: DocumentState[] = [];
let activeId = '';
let folder: Folder | null = null;
let sourceMode = false;
let loading = false;
let sidebarTab = 'files';
let saving = false;
let persistTimer: ReturnType<typeof setTimeout>;
let toastTimer: ReturnType<typeof setTimeout>;
let sourceReason: string | null = null;
const theme = new Compartment();
function current() { return documents.find(d => d.id === activeId)!; }
function toast(message: string) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  $('toast').classList.add('visible', 'is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').classList.remove('visible', 'is-visible'); $('toast').hidden = true; }, 4000);
}
function fail(error: unknown) { console.error(error); toast(error instanceof Error ? error.message : String(error)); }
const safe = (fn: () => unknown) => { try { Promise.resolve(fn()).catch(fail); } catch (e) { fail(e); } };
function button(id: string, fn: () => unknown) { $(id)?.addEventListener('click', () => safe(fn)); }
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE, JSON.stringify({ documents, activeId })); }
    catch { $('status-message').textContent = '草稿空间不足，请保存到文件'; }
  }, 200);
}
function syncDirty() {
  if (!current()) return;
  call('setDirty', { dirty: documents.some(d => d.dirty), name: current().name }).catch(fail);
}
function updateContent(content: string) {
  if (loading || !current()) return;
  current().content = content;
  current().dirty = current().savedContent !== content;
  persist(); updateStatus(); renderFiles(); renderOutline(); syncDirty();
}
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true, fontFamily: 'system-ui' });
let diagramIndex = 0;
const Code = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, editor: instance, getPos }) => {
      let latest = node;
      let alive = true;
      let generation = 0;
      const dom = document.createElement('div'); dom.className = 'code-block-shell';
      const label = document.createElement('button'); label.className = 'code-language'; label.contentEditable = 'false'; label.type = 'button';
      const pre = document.createElement('pre'); const code = document.createElement('code'); pre.append(code);
      const preview = document.createElement('div'); preview.className = 'diagram-preview'; preview.contentEditable = 'false';
      dom.append(label, pre, preview);
      const paint = async () => {
        label.textContent = latest.attrs.language || 'plain text';
        label.title = '设置代码语言（如 javascript、python、mermaid）';
        preview.hidden = latest.attrs.language !== 'mermaid';
        const turn = ++generation;
        if (preview.hidden) return;
        try {
          const result = await mermaid.render('diagram-' + ++diagramIndex, latest.textContent);
          if (alive && turn === generation) preview.innerHTML = result.svg;
        } catch {
          if (alive && turn === generation) preview.textContent = '图表语法尚未完成，继续编辑即可。';
        }
      };
      label.addEventListener('click', () => safe(async () => {
        const language = await ask('代码语言', latest.attrs.language || '', '例如 javascript / mermaid');
        const pos = getPos();
        if (language !== null && typeof pos === 'number') instance.commands.command(({ tr, dispatch }) => {
          dispatch?.(tr.setNodeMarkup(pos, undefined, { ...latest.attrs, language: language.trim() || null })); return true;
        });
      }));
      void paint();
      return { dom, contentDOM: code, update(next) {
        if (next.type !== latest.type) return false;
        const changed = next.textContent !== latest.textContent || next.attrs.language !== latest.attrs.language;
        latest = next; if (changed) void paint(); return true;
      }, ignoreMutation(mutation) { return mutation.type !== 'selection' && !code.contains(mutation.target); },
      stopEvent(event) { return label.contains(event.target as Node); },
      destroy() { alive = false; generation++; } };
    };
  },
}).configure({ lowlight: createLowlight(common), enableTabIndentation: true });

const LocalImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('img');
      let generation = 0;
      const paint = async (attrs: Record<string, any>) => {
        const version = ++generation;
        dom.alt = attrs.alt || ''; dom.title = attrs.title || '';
        const src = String(attrs.src || '');
        if (/^(https?:\/\/|data:image\/(png|jpeg|gif|webp|bmp);base64,)/i.test(src)) dom.src = src;
        else if (native && current()?.path) {
          try {
            const result = await call('resolveImage', { path: src, documentPath: current().path });
            if (version === generation) dom.src = result.url;
          } catch { dom.removeAttribute('src'); dom.alt = '图片不可用：' + src; }
        } else { dom.removeAttribute('src'); dom.alt = '本地图片需从桌面应用打开：' + src; }
      };
      void paint(node.attrs);
      return { dom, update(next) { if (next.type.name !== 'image') return false; void paint(next.attrs); return true; }, destroy() { generation++; } };
    };
  },
}).configure({ allowBase64: true });

const editor = new Editor({
  element: $('editor'),
  extensions: [
    StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    Placeholder.configure({ placeholder: '写点什么，或输入 # 开始一个标题…' }),
    TableKit.configure({ table: { resizable: true } }), TaskList, TaskItem.configure({ nested: true }),
    LocalImage, Code, Focus.configure({ className: 'has-focus', mode: 'shallowest' }),
    Mathematics.configure({
      inlineOptions: { onClick: async (node, pos) => {
        const latex = await ask('编辑行内公式', node.attrs.latex);
        if (latex !== null) editor.chain().setNodeSelection(pos).updateInlineMath({ latex }).focus().run();
      } },
      blockOptions: { onClick: async (node, pos) => {
        const latex = await ask('编辑数学公式', node.attrs.latex);
        if (latex !== null) editor.chain().setNodeSelection(pos).updateBlockMath({ latex }).focus().run();
      } },
    }),
  ],
  contentType: 'markdown', content: '',
  editorProps: {
    attributes: { 'aria-label': 'Markdown 可视化编辑器', spellcheck: 'false' },
    handlePaste(_view, event) {
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.some(f => f.type.startsWith('image/'))) return false;
      event.preventDefault();
      safe(async () => { for (const file of files) if (file.type.startsWith('image/')) editor.chain().focus().setImage({ src: await fileDataURL(file), alt: file.name }).run(); });
      return true;
    },
    handleDrop(_view, event) {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return false;
      event.preventDefault();
      safe(async () => {
        for (const file of files) {
          if (file.type.startsWith('image/')) editor.chain().focus().setImage({ src: await fileDataURL(file), alt: file.name }).run();
          else if (/\.(md|markdown|mdown|txt)$/i.test(file.name)) addDocument({ id: crypto.randomUUID(), path: null, name: file.name, content: await file.text() }, true);
        }
      }); return true;
    },
    handleClick(_view, _pos, event) {
      const link = (event.target as HTMLElement).closest('a');
      if (link && (event.metaKey || event.ctrlKey)) {
        const href = link.getAttribute('href');
        if (href && /^https?:\/\//.test(href)) window.open(href, '_blank', 'noopener');
        return true;
      } return false;
    },
  },
  onUpdate: () => updateContent(editor.getMarkdown()),
  onSelectionUpdate: () => {
    updateFormatting();
    if (document.body.classList.contains('is-typewriter')) {
      editor.view.domAtPos(editor.state.selection.from).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  },
});
const source = new EditorView({
  parent: $('source-editor'),
  state: createSourceState(''),
});
function createSourceState(content: string) {
  return EditorState.create({ doc: content, extensions: [
    basicSetup, markdown(), EditorView.lineWrapping, search({ top: true }), keymap.of(searchKeymap),
    theme.of(document.documentElement.dataset.theme === 'dark' ? oneDark : []),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码编辑器', spellcheck: 'false' }),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !loading && sourceMode) updateContent(update.state.doc.toString());
      if (update.selectionSet && sourceMode) {
        const line = update.state.doc.lineAt(update.state.selection.main.head);
        $('cursor-position').textContent = 'Ln ' + line.number + ', Col ' + (update.state.selection.main.head - line.from + 1);
      }
    }),
  ] });
}
function setSource(value: string) {
  source.setState(createSourceState(value));
}
function loadVisual(content: string) {
  editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false });
  // Each document/mode load starts a separate history. Undo must never reveal another file.
  editor.view.updateState(ProseMirrorState.create({
    doc: editor.state.doc, schema: editor.schema, plugins: editor.state.plugins,
  }));
}
function newDocument() {
  const number = documents.filter(d => d.name.startsWith('未命名')).length + 1;
  addDocument({ id: crypto.randomUUID(), path: null, name: '未命名' + (number > 1 ? ' ' + number : '') + '.md', content: '' }, false);
  (sourceMode ? source : editor.commands).focus();
}
function addDocument(doc: NativeDocument, dirty = false) {
  const existing = doc.path && documents.find(d => d.path === doc.path);
  if (existing) {
    if (existing.dirty && doc.content !== existing.savedContent) {
      existing.path = null;
      existing.name = existing.name.replace(/\.md$/i, '') + '（恢复副本）.md';
      toast('磁盘文件已改变，未保存内容已保留为独立草稿。');
    } else {
      if (!existing.dirty) { existing.content = doc.content; existing.savedContent = doc.content; }
      activate(existing.id); return;
    }
  }
  documents.push({ ...doc, id: !doc.id || documents.some(d => d.id === doc.id) ? crypto.randomUUID() : doc.id, savedContent: dirty ? '' : doc.content, dirty });
  activate(documents[documents.length - 1].id);
}
function activate(id: string) {
  activeId = id;
  const doc = current();
  loading = true;
  sourceReason = sourceOnlyReason(doc.content);
  setSource(doc.content);
  try { loadVisual(doc.content); }
  catch { sourceReason = '此文档暂不能在可视化模式中解析，源码已完整保留。'; }
  sourceMode = !!sourceReason || sourceMode;
  loading = false;
  applyMode(); renderFiles(); renderOutline(); updateStatus(); syncDirty(); persist();
  $('editor-scroll').scrollTop = 0;
  if (sourceReason) toast(sourceReason);
}
function applyMode() {
  document.body.classList.toggle('is-source', sourceMode);
  $('editor').hidden = sourceMode;
  $('source-editor').hidden = !sourceMode;
  $('format-toolbar').hidden = sourceMode;
  $('toggle-source').classList.toggle('active', sourceMode);
  $('toggle-source').setAttribute('aria-pressed', String(sourceMode));
  $('toggle-source').textContent = sourceMode ? '预览' : '源码';
  $('cursor-position').hidden = !sourceMode;
}
function toggleSource() {
  if (sourceMode) {
    sourceReason = sourceOnlyReason(current().content);
    if (sourceReason) { toast(sourceReason); return; }
    loading = true;
    try { loadVisual(current().content); }
    catch { loading = false; toast('解析失败，内容已完整保留在源码模式。'); return; }
    loading = false; sourceMode = false;
  } else { loading = true; setSource(current().content); loading = false; sourceMode = true; }
  applyMode();
  if (sourceMode) source.focus(); else editor.commands.focus();
}
function renderFiles() {
  const list = $('file-list'); list.replaceChildren();
  const filter = ($<HTMLInputElement>('file-search')?.value || '').toLowerCase();
  const folderNames = new Map(folder?.files.map(file => [file.path, file.relativePath || file.name]));
  const rows: { doc?: DocumentState; path?: string; name: string }[] = [
    ...documents.map(doc => ({ doc, path: doc.path || undefined, name: (doc.path && folderNames.get(doc.path)) || doc.name })),
    ...(folder?.files || []).filter(f => !documents.some(d => d.path === f.path)).map(f => ({ ...f, name: f.relativePath || f.name })),
  ];
  for (const row of rows.filter(r => r.name.toLowerCase().includes(filter))) {
    const el = document.createElement('button'); el.type = 'button';
    el.className = 'file-item' + (row.doc?.id === activeId ? ' is-active' : '');
    el.title = row.path || row.name;
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = '≡';
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = row.name.replace(/\.md$/i, '');
    const state = document.createElement('span'); state.className = 'file-meta'; state.textContent = row.doc?.dirty ? '●' : 'md';
    el.append(icon, name, state);
    el.addEventListener('click', () => safe(async () => row.doc ? activate(row.doc.id) : addDocument(await call('readFile', { path: row.path }))));
    list.append(el);
  }
  if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '没有匹配的文档'; list.append(empty); }
  $('folder-label').textContent = folder?.name || '我的文档';
}
function renderOutline() {
  const list = $('outline-list'); list.replaceChildren();
  outline(current()?.content || '').forEach((heading, index) => {
    const el = document.createElement('button'); el.className = 'outline-item'; el.dataset.level = String(heading.level);
    el.textContent = heading.text; el.title = heading.text;
    el.addEventListener('click', () => {
      if (sourceMode) {
        const line = source.state.doc.line(Math.min(heading.line, source.state.doc.lines));
        source.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) }); source.focus();
      } else $('editor').querySelectorAll('h1,h2,h3,h4,h5,h6')[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }); list.append(el);
  });
  if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '输入标题后，大纲会出现在这里'; list.append(empty); }
}
function updateStatus() {
  const doc = current(); if (!doc) return;
  $('document-name').textContent = doc.name;
  $('save-indicator').textContent = doc.dirty ? '未保存' : doc.path ? '已保存' : '本地草稿';
  $('save-indicator').classList.toggle('dirty', doc.dirty);
  const stat = statistics(doc.content);
  $('word-count').textContent = stat.words.toLocaleString() + ' 字 / 词';
  $('char-count').textContent = stat.characters.toLocaleString() + ' 字符';
  $('reading-time').textContent = '约 ' + stat.minutes + ' 分钟';
  document.title = doc.name + ' — TyporaX';
  updateFormatting();
}
function updateFormatting() {
  document.querySelectorAll<HTMLElement>('[data-format]').forEach(button => {
    const f = button.dataset.format!;
    const active = f.startsWith('heading') ? editor.isActive('heading', { level: Number(f.slice(-1)) }) : editor.isActive(f);
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
}
async function save(saveAs = false, documentId = activeId): Promise<boolean> {
  if (saving) return false;
  const doc = documents.find(d => d.id === documentId)!;
  const content = doc.content;
  saving = true;
  try {
    const result = await call<{ path: string | null; name: string } | null>('saveFile', { id: doc.id, path: doc.path, name: doc.name, content, saveAs });
    if (!result) return false;
    doc.path = result.path; doc.name = result.name; doc.savedContent = content; doc.dirty = doc.content !== content;
    persist(); updateStatus(); renderFiles(); syncDirty(); toast('已保存 ' + doc.name); return true;
  } finally { saving = false; }
}
async function openFile() {
  const result = await call<NativeDocument | null>('openFile');
  if (result) addDocument(result);
}
async function openFolder() {
  const result = await call<Folder | null>('openFolder');
  if (result) {
    folder = result; renderFiles(); setSidebar('files');
    toast('已打开 ' + result.name + (result.truncated ? '；文件列表已截断，部分文档未显示。' : ''));
  }
}
function setSidebar(tab: string) {
  sidebarTab = tab;
  $('file-list').hidden = tab !== 'files'; $('file-search').hidden = tab !== 'files'; $('outline-list').hidden = tab !== 'outline';
  document.querySelectorAll<HTMLElement>('[data-sidebar-tab]').forEach(el => {
    el.classList.toggle('active', el.dataset.sidebarTab === sidebarTab);
    el.classList.toggle('is-active', el.dataset.sidebarTab === sidebarTab);
    el.setAttribute('aria-pressed', String(el.dataset.sidebarTab === sidebarTab));
    el.setAttribute('aria-selected', String(el.dataset.sidebarTab === sidebarTab));
  });
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('typorax.theme', dark ? 'dark' : 'light');
  source.dispatch({ effects: theme.reconfigure(dark ? oneDark : []) });
  $('theme-toggle').setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题');
}
async function ask(label: string, value = '', placeholder = ''): Promise<string | null> {
  const dialog = $<HTMLDialogElement>('input-dialog');
  if (dialog.open) return null;
  $('dialog-label').textContent = label;
  const input = $<HTMLInputElement>('dialog-input'); input.value = value; input.placeholder = placeholder;
  return new Promise(resolve => {
    const close = () => { resolve(dialog.returnValue === 'confirm' ? input.value : null); dialog.removeEventListener('close', close); };
    dialog.addEventListener('close', close);
    dialog.showModal(); input.focus(); input.select();
  });
}
button('dialog-confirm', () => $<HTMLDialogElement>('input-dialog').close('confirm'));
button('dialog-cancel', () => $<HTMLDialogElement>('input-dialog').close('cancel'));
$('dialog-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $<HTMLDialogElement>('input-dialog').close('confirm'); } });

async function format(kind: string) {
  const chain = editor.chain().focus();
  if (kind.startsWith('heading')) chain.toggleHeading({ level: Number(kind.slice(-1)) as 1 | 2 | 3 }).run();
  else switch (kind) {
    case 'bold': chain.toggleBold().run(); break;
    case 'italic': chain.toggleItalic().run(); break;
    case 'strike': chain.toggleStrike().run(); break;
    case 'bulletList': chain.toggleBulletList().run(); break;
    case 'orderedList': chain.toggleOrderedList().run(); break;
    case 'taskList': chain.toggleTaskList().run(); break;
    case 'blockquote': chain.toggleBlockquote().run(); break;
    case 'codeBlock': chain.toggleCodeBlock().run(); break;
    case 'horizontalRule': chain.setHorizontalRule().run(); break;
    case 'table': chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
    case 'link': {
      const url = await ask('插入链接', editor.getAttributes('link').href || '', 'https://example.com');
      if (url === null) break;
      if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run();
      else if (/^(https?:\/\/|mailto:|#)/i.test(url)) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
      else toast('链接需以 https://、http://、mailto: 或 # 开头');
      break;
    }
  }
}
document.querySelectorAll<HTMLElement>('[data-format]').forEach(el => {
  el.addEventListener('mousedown', e => e.preventDefault());
  el.addEventListener('click', () => safe(() => format(el.dataset.format!)));
});
function insertMarkdown(markdown: string) {
  if (sourceMode) source.dispatch(source.state.replaceSelection(markdown));
  else editor.chain().focus().insertContent(markdown, { contentType: 'markdown' }).run();
}
async function insertImage() {
  const image = await call<{ url: string; markdownPath: string } | null>('chooseImage');
  if (!image) return;
  if (sourceMode) insertMarkdown('![图片](' + image.markdownPath + ')');
  else editor.chain().focus().setImage({ src: image.markdownPath, alt: '图片' }).run();
}

type Match = { from: number; to: number };
let matches: Match[] = [];
let matchIndex = -1;
function findMatches(): Match[] {
  const query = $<HTMLInputElement>('find-input').value;
  if (!query) return [];
  const result: Match[] = [];
  // Match against the original text: case folding can expand characters and change offsets.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const scan = (text: string, offset: number) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match && result.length < 5000; match = pattern.exec(text)) {
      result.push({ from: offset + match.index, to: offset + match.index + match[0].length });
    }
  };
  if (sourceMode) scan(source.state.doc.toString(), 0);
  else editor.state.doc.descendants((node, pos) => { if (node.isTextblock) { scan(node.textBetween(0, node.content.size, '', '\ufffc'), pos + 1); return false; } return true; });
  return result;
}
function refreshFind() {
  matches = findMatches(); matchIndex = -1;
  $('find-count').textContent = matches.length ? matches.length + ' 处匹配' : '无匹配';
}
function selectMatch(direction = 1) {
  matches = findMatches();
  if (!matches.length) { $('find-count').textContent = '无匹配'; return; }
  matchIndex = matchIndex < 0 ? (direction > 0 ? 0 : matches.length - 1) : (matchIndex + direction + matches.length) % matches.length;
  const m = matches[matchIndex];
  if (sourceMode) source.dispatch({ selection: { anchor: m.from, head: m.to }, effects: EditorView.scrollIntoView(m.from, { y: 'center' }) });
  else editor.chain().setTextSelection(m).scrollIntoView().run();
  $('find-count').textContent = (matchIndex + 1) + ' / ' + matches.length;
}
function replaceMatches(all = false) {
  const replacement = $<HTMLInputElement>('replace-input').value;
  matches = findMatches();
  if (!matches.length) return;
  if (!all && matchIndex < 0) { selectMatch(); return; }
  const selected = all ? matches : [matches[Math.min(matchIndex, matches.length - 1)]];
  if (sourceMode) source.dispatch({ changes: selected.map(m => ({ from: m.from, to: m.to, insert: replacement })) });
  else {
    const tr = editor.state.tr;
    for (const m of [...selected].reverse()) {
      if (replacement) tr.insertText(replacement, m.from, m.to); else tr.delete(m.from, m.to);
    }
    editor.view.dispatch(tr);
  }
  refreshFind(); if (!all) selectMatch();
}
function showFind() {
  $('find-panel').hidden = false; $<HTMLInputElement>('find-input').focus(); $<HTMLInputElement>('find-input').select(); refreshFind();
}
button('find-next', () => selectMatch()); button('find-prev', () => selectMatch(-1));
button('replace-one', () => replaceMatches()); button('replace-all', () => replaceMatches(true));
button('close-find', () => { $('find-panel').hidden = true; });
$('find-input').addEventListener('input', refreshFind);
$('find-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); selectMatch(event.shiftKey ? -1 : 1); } });

const exportCSS = 'body{font:17px/1.8 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;color:#252c29;max-width:800px;margin:48px auto;padding:0 32px}h1,h2,h3{line-height:1.35}h1{font-size:2.4em}h2{margin-top:1.8em}pre{background:#f3f5f2;padding:18px;border-radius:8px;white-space:pre-wrap}code{font-family:ui-monospace,monospace}blockquote{border-left:3px solid #789785;margin-left:0;padding-left:20px;color:#67756c}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dce2dc;padding:8px 12px;text-align:left}img,svg{max-width:100%;height:auto}a{color:#3c765d}ul[data-type=taskList]{list-style:none;padding-left:0}li[data-type=taskItem]{display:flex;gap:10px}li[data-type=taskItem]>div{flex:1}li p{margin:0}@media print{body{margin:0;padding:0}pre,table,blockquote{break-inside:avoid}h1,h2,h3{break-after:avoid}}';
async function exportHTML(): Promise<string> {
  const content = current().content;
  if (sourceMode && !sourceOnlyReason(content)) {
    loading = true;
    try { loadVisual(content); } finally { loading = false; }
  }
  const container = document.createElement('div');
  container.innerHTML = sourceOnlyReason(content) ? '<pre>' + escapeHTML(content) + '</pre>' : editor.getHTML();
  for (const el of container.querySelectorAll<HTMLElement>('[data-type="inline-math"],[data-type="block-math"]')) {
    try { el.innerHTML = katex.renderToString(el.dataset.latex || '', { displayMode: el.dataset.type === 'block-math', throwOnError: false }); } catch { /* preserve latex */ }
  }
  for (const code of container.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    try { const { svg } = await mermaid.render('export-diagram-' + ++diagramIndex, code.textContent || ''); code.parentElement!.outerHTML = svg; } catch { /* preserve readable source */ }
  }
  for (const image of container.querySelectorAll<HTMLImageElement>('img')) {
    const path = image.getAttribute('src') || '';
    if (!/^(https?:|data:)/i.test(path) && native && current().path) {
      try { image.src = (await call('resolveImage', { path, documentPath: current().path })).url; } catch { image.alt = '图片不可用：' + path; }
    }
  }
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + escapeHTML(current().name.replace(/\.md$/i, '')) + '</title><style>' + exportCSS + '\n' + katexCSS + '</style></head><body>' + container.innerHTML + '</body></html>';
}
async function exportDocument(kind: 'exportHTML' | 'exportPDF') {
  const html = await exportHTML();
  if (!native && kind === 'exportPDF') {
    const frame = document.createElement('iframe'); frame.className = 'print-frame'; document.body.append(frame);
    frame.srcdoc = html;
    frame.onload = () => { frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000); };
    return;
  }
  const result = await call(kind, { html, name: current().name });
  if (result) toast('已导出到 ' + result.path);
}
function setFocusMode(focused: boolean) {
  document.body.classList.toggle('is-focus', focused);
  $('focus-mode').classList.toggle('active', focused);
  $('focus-mode').setAttribute('aria-pressed', String(focused));
}
function setMenuOpen(open: boolean) {
  $('more-menu').hidden = !open;
  $('more-menu-toggle').setAttribute('aria-expanded', String(open));
}
async function command(action: string) {
  setMenuOpen(false);
  switch (action) {
    case 'new': newDocument(); break;
    case 'open': await openFile(); break;
    case 'openFolder': await openFolder(); break;
    case 'save': await save(); break;
    case 'saveAs': await save(true); break;
    case 'source': toggleSource(); break;
    case 'find': showFind(); break;
    case 'focus': setFocusMode(!document.body.classList.contains('is-focus')); break;
    case 'typewriter': {
      const enabled = document.body.classList.toggle('is-typewriter');
      document.querySelector('[data-action="typewriter"]')?.setAttribute('aria-checked', String(enabled));
      toast(enabled ? '打字机模式已开启' : '打字机模式已关闭'); break;
    }
    case 'theme': toggleTheme(); break;
    case 'exportHTML': case 'exportPDF': await exportDocument(action); break;
    case 'insertTable': if (sourceMode) insertMarkdown('\n| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n'); else await format('table'); break;
    case 'insertImage': await insertImage(); break;
    case 'shortcuts': $<HTMLDialogElement>('shortcuts-dialog').showModal(); break;
    case 'saveAndClose':
      for (const doc of documents.filter(d => d.dirty)) if (!await save(false, doc.id)) return;
      if (documents.some(d => d.dirty)) { toast('保存期间内容又有更新，请保存后再关闭。'); return; }
      await call('closeConfirmed'); break;
  }
}
window.__typoraxCommand = action => safe(() => command(action));
(window as any).__typoraxOpenDocument = (doc: NativeDocument) => addDocument(doc);
button('new-document', newDocument); button('open-file', openFile); button('open-folder', openFolder);
button('toggle-sidebar', () => document.body.classList.toggle('sidebar-hidden'));
button('toggle-source', toggleSource); button('theme-toggle', toggleTheme);
button('focus-mode', () => command('focus'));
button('more-menu-toggle', () => setMenuOpen(Boolean($('more-menu').hidden)));
button('close-shortcuts', () => $<HTMLDialogElement>('shortcuts-dialog').close());
document.querySelectorAll<HTMLElement>('[data-action]').forEach(el => el.addEventListener('click', () => safe(() => command(el.dataset.action!))));
document.querySelectorAll<HTMLElement>('[data-sidebar-tab]').forEach(el => el.addEventListener('click', () => setSidebar(el.dataset.sidebarTab!)));
$('file-search').addEventListener('input', renderFiles);
document.addEventListener('click', event => {
  if (!(event.target as HTMLElement).closest('#more-menu,#more-menu-toggle')) setMenuOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('find-panel').hidden = true; setMenuOpen(false); setFocusMode(false); }
  if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented || document.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase();
  let action = '';
  // Native menu equivalents are consumed by AppKit before reaching WebKit.
  if (key === 's') action = event.shiftKey ? 'saveAs' : 'save';
  if (key === 'o') action = event.shiftKey ? 'openFolder' : 'open';
  if (key === 'n') action = 'new';
  if (key === 'f') action = event.shiftKey ? 'focus' : 'find';
  if (key === '/') action = 'source';
  if (key === 'k' && !sourceMode) { event.preventDefault(); safe(() => format('link')); return; }
  if (action) { event.preventDefault(); event.stopPropagation(); safe(() => command(action)); }
}, { capture: true });
window.addEventListener('beforeunload', event => {
  try { localStorage.setItem(STORAGE, JSON.stringify({ documents, activeId })); } catch { /* status already reports draft storage failure */ }
  if (!native && documents.some(d => d.dirty)) event.preventDefault();
});
async function start() {
  const savedTheme = localStorage.getItem('typorax.theme') || 'light';
  document.documentElement.dataset.theme = savedTheme;
  source.dispatch({ effects: theme.reconfigure(savedTheme === 'dark' ? oneDark : []) });
  let restored: { documents: DocumentState[]; activeId: string } | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) || 'null');
    if (value?.documents?.every((d: any) => typeof d.id === 'string' && typeof d.content === 'string' && typeof d.name === 'string' && typeof d.savedContent === 'string')) restored = value;
  } catch { /* first run or corrupt draft cache */ }
  const boot = await call<{ documents: NativeDocument[]; folder: Folder | null; activePath?: string | null }>('bootstrap').catch(error => { fail(error); return { documents: [], folder: null, activePath: null }; });
  folder = boot.folder;
  // Only dirty drafts supersede disk contents. Native FileStore retains disk fingerprints.
  if (restored) {
    documents = restored.documents.filter(d => !d.path || d.dirty);
    for (const doc of documents.filter(d => d.path)) {
      try {
        const disk = await call<NativeDocument>('readFile', { path: doc.path });
        if (disk.content !== doc.savedContent) {
          doc.path = null; doc.name = doc.name.replace(/\.md$/i, '') + '（恢复副本）.md';
          toast('磁盘文件已改变，未保存内容已恢复为独立草稿。');
        }
      } catch {
        doc.path = null; doc.name = doc.name.replace(/\.md$/i, '') + '（恢复副本）.md';
      }
    }
  }
  for (const doc of boot.documents || []) if (!documents.some(d => d.path === doc.path)) documents.push({ ...doc, id: documents.some(d => d.id === doc.id) ? crypto.randomUUID() : doc.id, savedContent: doc.content, dirty: false });
  if (!documents.length) documents.push({ id: crypto.randomUUID(), path: null, name: '欢迎使用 TyporaX.md', content: WELCOME, savedContent: WELCOME, dirty: false });
  const requested = boot.activePath && documents.find(d => d.path === boot.activePath);
  activate(requested ? requested.id : documents.some(d => d.id === restored?.activeId) ? restored!.activeId : documents[0].id);
  setSidebar('files');
  $('status-message').textContent = native ? '本地文件 · UTF-8' : '浏览器预览 · 本地草稿';
  (window as any).__typoraxReady = true;
  await call('ready');
}
void start().catch(fail);
