import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
// Absolute paths: a trailing-slash specifier like 'buffer/' is treated as a file by the CJS resolver in Docker builds.
const r = (id: string) => req.resolve(id);

// Web build outputs to ../server/public so the server can serve the SPA.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Node built-ins that bundled CommonJS libraries (cipher-base, readable-stream, create-hash…) require.
    // Without these Vite swaps them for an empty stub, which breaks e.g. `class X extends require('stream').Transform`.
    alias: [
      { find: /^stream$/, replacement: r('stream-browserify') },
      { find: /^buffer$/, replacement: r('buffer/index.js') },
      { find: /^events$/, replacement: r('events/events.js') },
      { find: /^util$/, replacement: r('util/util.js') },
      { find: /^string_decoder$/, replacement: r('string_decoder/lib/string_decoder.js') },
      { find: /^process$/, replacement: r('process/browser.js') },
    ],
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
