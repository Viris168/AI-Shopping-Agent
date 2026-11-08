import { defineConfig } from 'vitest/config';

// Library mode → dist/widget.js, a single self-running IIFE. The entry exports nothing, so the
// bundle defines no globals of its own; only window.ShopChat (set at runtime) is shared.
export default defineConfig({
  build: {
    target: 'es2020',
    lib: {
      entry: 'src/index.ts',
      formats: ['iife'],
      name: 'ShopChatWidget',
      fileName: () => 'widget.js',
    },
  },
  test: {
    environment: 'happy-dom',
  },
});
