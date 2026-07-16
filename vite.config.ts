import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages ではリポジトリ名配下（/daiza/）で配信されるため base を合わせる。
// ローカル開発時はルート配信で問題ないが、本番配布物のパス整合のため常に固定する。
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
