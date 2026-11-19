import { defineConfig } from 'vite';
// index.html の大きなインラインスクリプト（アプリ本体）はそのまま出力する
export default defineConfig({
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  server: { hmr: process.env.DISABLE_HMR !== 'true' },
});
