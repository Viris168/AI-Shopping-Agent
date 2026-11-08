import { existsSync, readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Dev server on 8080 (the STOREFRONT_URL commerce-api links to). /api is proxied to
// commerce-api and /v1 to agent-service, so the browser talks to one origin and needs no CORS.
const API_TARGET = process.env.COMMERCE_API_URL ?? 'http://localhost:3000';
const AGENT_TARGET = process.env.AGENT_SERVICE_URL ?? 'http://localhost:8000';
const proxy = { '/api': API_TARGET, '/v1': AGENT_TARGET };

// The chat widget is its own build (../widget → dist/widget.js). Serve it at /widget.js, the
// same way a real store would load it from the chat CDN, and copy it into our dist on build.
const WIDGET_FILE = new URL('../widget/dist/widget.js', import.meta.url);

function chatWidget(): Plugin {
  const read = () => (existsSync(WIDGET_FILE) ? readFileSync(WIDGET_FILE) : null);
  const serve: Plugin['configureServer'] = (server) => {
    server.middlewares.use('/widget.js', (_req, res) => {
      const js = read();
      res.statusCode = js ? 200 : 404;
      res.setHeader('Content-Type', 'text/javascript');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(js ?? '// widget not built: run `npm run build` in ../widget');
    });
  };
  return {
    name: 'chat-widget',
    configureServer: serve,
    configurePreviewServer: serve as Plugin['configurePreviewServer'],
    generateBundle() {
      const js = read();
      if (js) this.emitFile({ type: 'asset', fileName: 'widget.js', source: js });
      else this.warn('../widget/dist/widget.js not found; the chat widget will not load. Build the widget first.');
    },
  };
}

export default defineConfig({
  plugins: [react(), chatWidget()],
  server: {
    port: 8080,
    strictPort: true,
    proxy,
  },
  preview: { port: 8080, proxy },
  test: {
    environment: 'happy-dom',
    // ChatWidget adds a <script src="/widget.js">; tests check the tag, not the widget itself.
    environmentOptions: { happyDOM: { settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } } },
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
