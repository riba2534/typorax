import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const plist = readFileSync(resolve(root, 'native/Info.plist'), 'utf8');
if (!plist.includes('<key>CFBundleShortVersionString</key><string>' + pkg.version + '</string>')) throw new Error('package.json and Info.plist versions differ');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'v' + pkg.version) throw new Error('Release tag does not match package version');
for (const file of ['LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'AGENTS.md', 'THIRD_PARTY_NOTICES.md', 'assets/logo.png', 'docs/validation.md']) {
  if (!existsSync(resolve(root, file))) throw new Error('Missing release file: ' + file);
}
if (!readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8').includes('## ' + pkg.version + ' ')) throw new Error('Changelog missing current version');
const logo = readFileSync(resolve(root, 'assets/logo.png'));
if (logo.readUInt32BE(0) !== 0x89504e47 || ![4, 6].includes(logo[25])) throw new Error('Logo must be a PNG with alpha');
function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}
const files = [...['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'AGENTS.md'].map(file => resolve(root, file)), ...markdownFiles(resolve(root, 'docs')), resolve(root, 'native/README.md')];
let links = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/^`{3,}[\s\S]*?^`{3,}\s*$/gm, '');
  if (/\/Users\/|\/tmp\/typorax/.test(text)) throw new Error('Personal path in ' + relative(root, file));
  const references = [...text.matchAll(/\[[^\]]*]\(([^)\s]+)\)|(?:src|href)="([^"]+)"/g)];
  for (const match of references) {
    const target = match[1] || match[2];
    if (/^(?:https?:|mailto:|data:)/.test(target)) continue;
    const [pathname, anchor] = target.split('#');
    const destination = pathname ? resolve(dirname(file), decodeURIComponent(pathname)) : file;
    if (!existsSync(destination)) throw new Error(relative(root, file) + ': missing ' + target);
    if (anchor && destination.endsWith('.md')) {
      const source = readFileSync(destination, 'utf8');
      const headings = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
      if (!headings.includes(decodeURIComponent(anchor))) throw new Error(relative(root, file) + ': missing anchor ' + target);
    }
    links++;
  }
}
console.log('Release metadata and ' + links + ' local documentation links: PASS (' + pkg.version + ')');
