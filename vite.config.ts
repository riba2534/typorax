import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2022', assetsInlineLimit: Infinity, chunkSizeWarningLimit: 15000 },
  server: { host: '127.0.0.1', watch: { ignored: ['**/build/**', '**/dist/**'] } },
});
