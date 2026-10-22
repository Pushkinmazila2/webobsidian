import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web build outputs to ../server/public so the server can serve the SPA.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Node built-ins that bundled CommonJS libraries (cipher-base, readable-stream, create-hash…) require.
    // Without these Vite swaps them for an empty stub, which breaks e.g. `class X extends require('stream').Transform`.
    alias: [
      { find: /^stream$/, replacement: 'stream-browserify' },
      { find: /^buffer$\/?$/, replacement: 'buffer/' },
      { find: /^events$/, replacement: 'events/' },
      { find: /^util$/, replacement: 'util/' },
      { find: /^string_decoder$/, replacement: 'string_decoder/' },
      { find: /^process$/, replacement: 'process/browser.js' },
    ],
  },
  define: {
    'global': 'globalThis',
    'process.env': {},
    // Внедряем глобальный класс Buffer для старых библиотек
    'window.Buffer': 'Buffer', 
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lang-markdown',
            '@codemirror/theme-one-dark',
          ],
          markdown: [
            'unified',
            'remark-parse',
            'remark-gfm',
            'remark-rehype',
            'rehype-raw',
            'rehype-sanitize',
            'rehype-stringify',
          ],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/public': 'http://localhost:8787',
      '/share': 'http://localhost:8787', // SSR share page is server-rendered even in dev
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
