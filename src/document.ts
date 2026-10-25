export const WELCOME = '# 把想法，写成自己的样子。\n\n欢迎来到 **TyporaX**。这是你的本地 Markdown 写作空间：免费、开源，不需要账户。\n\n## 从一行文字开始\n\n试着修改这段文字，或在新的一行输入 \x60## \x60。标记会自然变成标题，让你专注于内容本身。\n\n> 好的写作工具，让文字站在最前面。\n\n## 一份轻盈的写作清单\n\n- [x] 即写即呈现的 Markdown\n- [x] 原生打开、保存与文件夹工作区\n- [ ] 写下今天最值得记住的一件事\n\n## 给想法一点结构\n\n| 工作方式 | 快捷键 |\n| --- | --- |\n| 保存文档 | ⌘ S |\n| 打开文档 | ⌘ O |\n| 切换源码 | ⌘ / |\n| 查找与替换 | ⌘ F |\n\n### 代码，也可以很清晰\n\n\x60\x60\x60javascript\nfunction writeSomething() {\n  return \"Make room for your ideas.\";\n}\n\x60\x60\x60\n\n数学公式也在这里：$E = mc^2$。\n\n---\n\n所有内容都在本机。点击左上角 **新建**，开始你的第一篇文档。\n';
export function statistics(markdown: string) {
  const plain = markdown.replace(/\x60{3}[\s\S]*?\x60{3}/g, m => m.replace(/^\x60{3}.*$/gm, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_~>|\x60]/g, '');
  const cjk = plain.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  const words = plain.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  const count = cjk.length + words.length;
  return { words: count, characters: Array.from(plain.replace(/\s/g, '')).length, minutes: Math.max(1, Math.ceil(count / 300)) };
}
export function outline(markdown: string) {
  let fenced = false;
  return markdown.split('\n').flatMap((line, index) => {
    if (/^\s*(\x60{3,}|~{3,})/.test(line)) { fenced = !fenced; return []; }
    const match = !fenced && /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    return match ? [{ level: match[1].length, text: match[2].replace(/[*_\x60]/g, ''), line: index + 1 }] : [];
  });
}
/** Structures outside the visual schema remain source-only to avoid silent data loss. */
export function sourceOnlyReason(markdown: string): string | null {
  const body = markdown.replace(/^(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  if (/^(---|\+\+\+)\r?\n/.test(markdown)) return '此文档包含前置元数据，已用源码模式完整保留。';
  if (/^\[\^[^\]]+\]:/m.test(body)) return '此文档包含脚注，已用源码模式完整保留。';
  if (/<\/?[A-Za-z][^>]*>|<!--/.test(body)) return '此文档包含原生 HTML，已用源码模式完整保留。';
  if (/^:::|^ {0,3}\[[^\]]+\]:\s+\S/m.test(body)) return '此文档包含扩展语法，已用源码模式完整保留。';
  return null;
}
export function escapeHTML(value: string) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
